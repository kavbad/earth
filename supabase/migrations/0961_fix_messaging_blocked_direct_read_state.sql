-- 0961 — fix: messaging invariants around blocked direct conversations, read state and tombstones
-- (spec §21, §27, §55, §56, §128; DB_API §2; 0170 / 0185 / 0250 / 0260 / 0270 review).
--
-- supabase/tests/src/verify/messaging.test.ts reproduced five sequences that slipped past 0260 / 0270
-- although 0740 records "direct messages unreadable either way" for a blocked pair:
--
--   1. After B blocked A, `conversation_read_receipts(dm)` still answered both sides with the other
--      Human's `lastReadMessageId` and `lastReadAt` (it only checked membership), and the `conversations`
--      / `conversation_members` rows of the direct conversation stayed selectable — and therefore
--      deliverable through the realtime publication (0280) — to both sides, while `messages`,
--      `message_reactions`, `conversation_get`, `conversations_list` and every messaging RPC already
--      hid the conversation. The two policies now use `earth.can_view_conversation` (0260), the same
--      block-aware member check as `messages`, and the receipts RPC goes through
--      `earth.assert_conversation_access` (`blocked` like every other conversation RPC).
--   2. The own-row update grant of `conversation_members` (0170: `last_read_message_id`, `last_read_at`,
--      `mute_state`, `notification_level`) let a member point `last_read_message_id` at a message of
--      another conversation: the foreign key only reaches `messages(id)`. A before trigger now keeps
--      the pointer inside its conversation (`invalid_input`), whichever path writes it.
--   3. `conversation_mark_read(conversation, older_message)` zeroed `unread_count` although newer
--      messages remained after the pointer, so the chats list lost its unread state for a conversation
--      that still had unread messages (spec §55: the pointer is the read state). The count is now
--      recomputed from the resolved pointer — messages of other members after it — which is 0 exactly
--      when the pointer is the newest message (the documented case) and the trigger of 0250 keeps
--      incrementing from there.
--   4. A tombstone (spec §27, DB_API §2: `text = null`, `payload = '{}'`) left the message text in the
--      `preview` of the `direct_message` / `group_message` notifications that `message_send` had
--      created, readable through `notifications_list` and pushed by `notifications_unsent`. An after
--      trigger scrubs the preview when a message is tombstoned, whichever path tombstones it.
--
-- Nothing else changes: signatures, grants and rate limits are the ones 0185 / 0270 / 0730 declare;
-- notifications created before a block stay history (safety/block-overrides.test.ts).

-- ---------------------------------------------------------------------------------------------------
-- 1. A blocked direct conversation has no readable row and no read receipts, either way.
-- ---------------------------------------------------------------------------------------------------

drop policy if exists conversations_select_member on public.conversations;
create policy conversations_select_member on public.conversations
  for select to authenticated
  using (earth.can_view_conversation(id, earth.current_human()));

drop policy if exists conversation_members_select_member on public.conversation_members;
create policy conversation_members_select_member on public.conversation_members
  for select to authenticated
  using (earth.can_view_conversation(conversation_id, earth.current_human()));

-- Same body as 0185 except the access check: `conversation_not_found` for non-members, `blocked`
-- for a direct conversation with a block either way.
create or replace function public.conversation_read_receipts(conversation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_conv public.conversations := earth.assert_conversation_access(conversation_id, v_me);
begin
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'humanId', cm.human_id,
             'lastReadMessageId', cm.last_read_message_id,
             'lastReadAt', to_jsonb(cm.last_read_at)
           ) order by cm.joined_at, cm.human_id), '[]'::jsonb)
      from public.conversation_members cm
      join public.humans h on h.id = cm.human_id and h.status = 'active'
     where cm.conversation_id = v_conv.id
  );
end
$$;

revoke execute on function public.conversation_read_receipts(uuid) from public;
grant execute on function public.conversation_read_receipts(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------
-- 2. The read pointer never leaves its conversation, whichever path writes it.
-- ---------------------------------------------------------------------------------------------------

create or replace function earth.conversation_members_read_pointer_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, earth, private, pg_temp
as $$
begin
  if new.last_read_message_id is not null
     and not exists (
       select 1 from public.messages m
        where m.id = new.last_read_message_id and m.conversation_id = new.conversation_id
     ) then
    perform earth.raise('invalid_input', 'last_read_message_id must be a message of the conversation');
  end if;
  return new;
end
$$;

revoke execute on function earth.conversation_members_read_pointer_trigger() from public, anon, authenticated;

create trigger conversation_members_read_pointer
  before insert or update of last_read_message_id on public.conversation_members
  for each row execute function earth.conversation_members_read_pointer_trigger();

-- ---------------------------------------------------------------------------------------------------
-- 3. conversation_mark_read: the unread count follows the pointer.
-- ---------------------------------------------------------------------------------------------------

-- Same signature, rate limit and result shape as 0270 (`ConversationReadStateDto`); the pointer still
-- never moves backwards and defaults to the newest message. `unread_count` becomes the number of
-- messages by other members after the resolved pointer (every message when there is no pointer).
create or replace function public.conversation_mark_read(conversation_id uuid, message_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_conv public.conversations := earth.assert_conversation_access(conversation_id, v_me);
  v_target public.messages%rowtype;
  v_current public.messages%rowtype;
  v_read public.messages%rowtype;
  v_unread integer;
  v_row public.conversation_members%rowtype;
begin
  perform earth.rate_limit_for_caller('conversation_mark_read', 240, 60);
  if message_id is not null then
    select m.* into v_target from public.messages m where m.id = message_id and m.conversation_id = v_conv.id;
    if not found then
      perform earth.raise('message_not_found');
    end if;
  else
    select m.* into v_target
      from public.messages m
     where m.conversation_id = v_conv.id
     order by m.created_at desc, m.id desc
     limit 1;
  end if;

  select m.* into v_current
    from public.conversation_members cm
    join public.messages m on m.id = cm.last_read_message_id
   where cm.conversation_id = v_conv.id and cm.human_id = v_me;

  if v_target.id is null then
    v_read := v_current;
  elsif v_current.id is null
     or (v_target.created_at, v_target.id) >= (v_current.created_at, v_current.id) then
    v_read := v_target;
  else
    v_read := v_current;
  end if;

  select count(*)::integer into v_unread
    from public.messages m
   where m.conversation_id = v_conv.id
     and m.sender_human_id <> v_me
     and (v_read.id is null or (m.created_at, m.id) > (v_read.created_at, v_read.id));

  update public.conversation_members cm
     set last_read_message_id = v_read.id, last_read_at = now(), unread_count = v_unread
   where cm.conversation_id = v_conv.id and cm.human_id = v_me
  returning cm.* into v_row;

  return jsonb_build_object(
    'conversationId', v_row.conversation_id,
    'lastReadMessageId', v_row.last_read_message_id,
    'lastReadAt', to_jsonb(v_row.last_read_at),
    'unreadCount', v_row.unread_count
  );
end
$$;

revoke execute on function public.conversation_mark_read(uuid, uuid) from public;
grant execute on function public.conversation_mark_read(uuid, uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------
-- 4. A tombstone leaves no preview behind in the notifications that copied the text.
-- ---------------------------------------------------------------------------------------------------

create or replace function earth.messages_tombstone_notifications_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, earth, private, pg_temp
as $$
begin
  update public.notifications n
     set payload = n.payload || jsonb_build_object('preview', '')
   where n.object_type = 'message'
     and n.object_id = new.id
     and n.payload ? 'preview';
  return new;
end
$$;

revoke execute on function earth.messages_tombstone_notifications_trigger() from public, anon, authenticated;

create trigger messages_tombstone_notifications
  after update of deleted_at on public.messages
  for each row
  when (old.deleted_at is null and new.deleted_at is not null)
  execute function earth.messages_tombstone_notifications_trigger();

-- Fail loudly if a later range drops what this fix depends on.
do $$
begin
  if to_regprocedure('earth.can_view_conversation(uuid, uuid)') is null
     or to_regprocedure('earth.assert_conversation_access(uuid, uuid)') is null
     or to_regprocedure('earth.conversation_members_read_pointer_trigger()') is null
     or to_regprocedure('earth.messages_tombstone_notifications_trigger()') is null then
    raise exception '0961: messaging primitives missing';
  end if;
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.conversation_members'::regclass and t.tgname = 'conversation_members_read_pointer' and not t.tgisinternal
  ) or not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.messages'::regclass and t.tgname = 'messages_tombstone_notifications' and not t.tgisinternal
  ) then
    raise exception '0961: triggers on conversation_members / messages are missing';
  end if;
  if (
    select count(distinct p.tablename) from pg_policies p
     where p.schemaname = 'public' and p.tablename in ('conversations', 'conversation_members')
       and p.cmd = 'SELECT' and p.qual like '%can_view_conversation%'
  ) <> 2 then
    raise exception '0961: block-aware select policies on conversations / conversation_members are missing';
  end if;
end
$$;
