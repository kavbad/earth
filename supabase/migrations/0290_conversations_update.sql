-- 0290 — conversation summaries over real messages (DB_API §2 `conversations_list` /
-- `conversation_get`; SCREEN 08 "last meaningful message", unread state).
--
-- 0185 shipped `earth.last_message_json` as a guarded dynamic query (the messages table did not
-- exist yet) and the list/detail RPCs on top of it. Now that `public.messages` exists (0250) the
-- preview is a plain indexed query — the latest non-deleted message, including system lines — and
-- `unreadCount` is the trigger-maintained `conversation_members.unread_count`, zeroed by
-- `conversation_mark_read` (0270). The RPCs are re-created with identical signatures and behavior:
-- ordered by activity, keyset on the activity timestamp, blocked direct conversations hidden.

create or replace function earth.last_message_json(p_conversation_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
           'id', m.id,
           'senderHumanId', m.sender_human_id,
           'senderDisplayName', coalesce(earth.display_name_of(m.sender_human_id), 'Earth member'),
           'type', m.type,
           'text', m.text,
           'createdAt', to_jsonb(m.created_at)
         )
    from public.messages m
   where m.conversation_id = p_conversation_id
     and m.deleted_at is null
   order by m.created_at desc, m.id desc
   limit 1
$$;

create or replace function public.conversations_list(cursor timestamptz default null, "limit" integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_cursor timestamptz := cursor;
  v_limit integer := least(greatest(coalesce("limit", 30), 1), 100);
  v_items jsonb;
  v_next timestamptz;
  v_count integer;
begin
  with page as (
    select c.id, coalesce(c.last_message_at, c.created_at) as sort_at
      from public.conversations c
      join public.conversation_members cm on cm.conversation_id = c.id and cm.human_id = v_me
     where (v_cursor is null or coalesce(c.last_message_at, c.created_at) < v_cursor)
       and not (c.type = 'direct' and earth.is_blocked_either(v_me, earth.direct_other_member(c.id, v_me)))
     order by coalesce(c.last_message_at, c.created_at) desc, c.id
     limit v_limit
  )
  select coalesce(jsonb_agg(earth.conversation_summary_json(page.id, v_me) order by page.sort_at desc, page.id), '[]'::jsonb),
         min(page.sort_at),
         count(*)
    into v_items, v_next, v_count
    from page;

  return jsonb_build_object(
    'conversations', v_items,
    'nextCursor', case when v_count = v_limit then to_jsonb(v_next) else null end
  );
end
$$;

create or replace function public.conversation_get(conversation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_id uuid := conversation_id;
  v_type public.conversation_type;
  v_members jsonb;
begin
  if not earth.is_conversation_member(v_id, v_me) then
    perform earth.raise('conversation_not_found');
  end if;
  select c.type into v_type from public.conversations c where c.id = v_id;
  if v_type = 'direct' and earth.is_blocked_either(v_me, earth.direct_other_member(v_id, v_me)) then
    perform earth.raise('blocked');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'humanId', cm.human_id,
           'displayName', p.display_name,
           'handle', p.handle,
           'avatarUrl', earth.public_media_url(p.avatar_media_id),
           'joinedAt', to_jsonb(cm.joined_at),
           'lastReadMessageId', cm.last_read_message_id
         ) order by cm.joined_at, p.display_name, cm.human_id), '[]'::jsonb)
    into v_members
    from public.conversation_members cm
    join public.humans h on h.id = cm.human_id and h.status = 'active'
    join public.public_identities p on p.human_id = cm.human_id
   where cm.conversation_id = v_id;

  return earth.conversation_summary_json(v_id, v_me) || jsonb_build_object('members', v_members);
end
$$;

-- Grants from 0185 carry over (create or replace keeps them): anon, authenticated, service_role.
