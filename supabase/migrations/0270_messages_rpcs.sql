-- 0270 — messaging RPCs (DB_API §2 from `messages_list` onward; spec §53–56, §83, §86, §108).
--
-- Every RPC runs as the owner, validates the caller with earth.assert_human(), reads the
-- conversation through earth.assert_conversation_access (membership → `conversation_not_found`,
-- blocked direct conversation → `blocked`) and answers with `MessageDto` / `MessagesPageDto` shapes
-- (packages/domain/src/dto/conversations.ts). `message_send` is idempotent on
-- `(conversation_id, sender, client_id)` (spec §53, §108) and rate limited 60/min (spec §83);
-- notifications are created here for the recipients that want them (spec §86).
-- `earth.system_message` is the single way a system line ("Alice joined") enters a thread; group
-- joins and leaves call it (0275) and rooms will (03xx).

-- ---------------------------------------------------------------------------------------------------
-- Access helpers
-- ---------------------------------------------------------------------------------------------------

-- The conversation, or raises `conversation_not_found` (missing or not a member) / `blocked`
-- (direct conversation with a block either way).
create or replace function earth.assert_conversation_access(p_conversation_id uuid, p_viewer uuid)
returns public.conversations
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_conv public.conversations%rowtype;
begin
  if p_conversation_id is not null and p_viewer is not null then
    select c.* into v_conv
      from public.conversations c
      join public.conversation_members cm on cm.conversation_id = c.id and cm.human_id = p_viewer
     where c.id = p_conversation_id;
  end if;
  if v_conv.id is null then
    perform earth.raise('conversation_not_found');
  end if;
  if v_conv.type = 'direct'
     and earth.is_blocked_either(p_viewer, earth.direct_other_member(v_conv.id, p_viewer)) then
    perform earth.raise('blocked');
  end if;
  return v_conv;
end
$$;

-- The message, or raises `message_not_found` (missing, or the viewer is not a member of its
-- conversation) / `blocked` (direct conversation with a block either way).
create or replace function earth.assert_message_access(p_message_id uuid, p_viewer uuid)
returns public.messages
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_msg public.messages%rowtype;
  v_type public.conversation_type;
begin
  if p_message_id is not null then
    select m.* into v_msg from public.messages m where m.id = p_message_id;
  end if;
  if v_msg.id is null or not earth.is_conversation_member(v_msg.conversation_id, p_viewer) then
    perform earth.raise('message_not_found');
  end if;
  select c.type into v_type from public.conversations c where c.id = v_msg.conversation_id;
  if v_type = 'direct'
     and earth.is_blocked_either(p_viewer, earth.direct_other_member(v_msg.conversation_id, p_viewer)) then
    perform earth.raise('blocked');
  end if;
  return v_msg;
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- JSON shapes
-- ---------------------------------------------------------------------------------------------------

-- `MessageReactionSummaryDto[]`, ordered by first reaction then label.
create or replace function earth.message_reactions_json(p_message_id uuid, p_viewer uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object('reaction', r.reaction, 'count', r.count, 'reactedByMe', r.mine)
      order by r.first_at, r.reaction
    ),
    '[]'::jsonb
  )
  from (
    select mr.reaction,
           count(*)::integer as count,
           coalesce(bool_or(mr.human_id = p_viewer), false) as mine,
           min(mr.created_at) as first_at
      from public.message_reactions mr
     where mr.message_id = p_message_id
     group by mr.reaction
  ) r
$$;

-- `MessageDto` as seen by `p_viewer` (tombstones keep their identity columns; content is null/{}).
create or replace function earth.message_json(p_message_id uuid, p_viewer uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
    'id', m.id,
    'conversationId', m.conversation_id,
    'senderHumanId', m.sender_human_id,
    'type', m.type,
    'text', m.text,
    'payload', m.payload,
    'replyToMessageId', m.reply_to_message_id,
    'createdAt', to_jsonb(m.created_at),
    'editedAt', to_jsonb(m.edited_at),
    'deletedAt', to_jsonb(m.deleted_at),
    'clientId', m.client_id,
    'reactions', earth.message_reactions_json(m.id, p_viewer)
  )
  from public.messages m
  where m.id = p_message_id
$$;

-- Notification preview (spec §86): the text collapsed to one line and cut to 120 characters, or a
-- label for media messages without a caption ("Dad: photo").
create or replace function earth.message_preview(p_type public.message_type, p_text text)
returns text
language sql
immutable
set search_path = public, earth, private, pg_temp
as $$
  select case
           when nullif(btrim(coalesce(p_text, '')), '') is not null
             then left(regexp_replace(btrim(p_text), '\s+', ' ', 'g'), 120)
           when p_type = 'image' then 'Photo'
           when p_type = 'video' then 'Video'
           when p_type = 'audio' then 'Voice message'
           when p_type = 'file' then 'File'
           when p_type = 'poll' then 'Poll'
           when p_type = 'place' then 'Place'
           when p_type = 'plan' then 'Plan'
           else ''
         end
$$;

-- ---------------------------------------------------------------------------------------------------
-- System messages
-- ---------------------------------------------------------------------------------------------------

-- Inserts a `system` message ("Alice joined") and returns its id. The sender is the acting Human:
-- `p_actor_human_id`, else `payload.actorHumanId`, else the caller's Human (`invalid_input` when
-- none). `actorHumanId` is always written into the payload. Unread counts, `last_message_at` and
-- `groups.last_activity_at` follow from the insert trigger (0250); no notification is created.
-- Call with typed arguments (`'...'::text`, `'{}'::jsonb`) when both text and payload are literals:
-- the legacy `(conversation, human, text)` form below is otherwise ambiguous.
create or replace function earth.system_message(
  p_conversation_id uuid,
  p_text text,
  p_payload jsonb default '{}'::jsonb,
  p_actor_human_id uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_text text := nullif(btrim(coalesce(p_text, '')), '');
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_actor uuid;
  v_id uuid;
begin
  if p_conversation_id is null
     or not exists (select 1 from public.conversations c where c.id = p_conversation_id) then
    perform earth.raise('conversation_not_found');
  end if;
  if v_text is null or length(v_text) > 4000 then
    perform earth.raise('invalid_input', 'system_message: text is required (at most 4000 characters)');
  end if;
  if jsonb_typeof(v_payload) <> 'object' then
    perform earth.raise('invalid_input', 'system_message: payload must be an object');
  end if;
  v_actor := coalesce(p_actor_human_id, nullif(v_payload ->> 'actorHumanId', '')::uuid, earth.current_human());
  if v_actor is null then
    perform earth.raise('invalid_input', 'system_message: an acting Human is required');
  end if;

  insert into public.messages (conversation_id, sender_human_id, type, text, payload)
  values (p_conversation_id, v_actor, 'system', v_text, v_payload || jsonb_build_object('actorHumanId', v_actor))
  returning id into v_id;
  return v_id;
end
$$;

-- Legacy form from 0185 (`conversation, acting human, text`), kept for callers written against it.
create or replace function earth.system_message(p_conversation_id uuid, p_human_id uuid, p_text text)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
begin
  return earth.system_message(p_conversation_id, p_text, '{}'::jsonb, p_human_id);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------------------------------

-- Newest first, keyset on `(created_at, id)` before `before_id`; `nextCursor` is the id to pass next.
create or replace function public.messages_list(conversation_id uuid, before_id uuid default null, "limit" integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_conv public.conversations := earth.assert_conversation_access(conversation_id, v_me);
  v_limit integer := least(greatest(coalesce("limit", 50), 1), 200);
  v_before public.messages%rowtype;
  v_ids uuid[];
  v_next uuid;
  v_items jsonb;
begin
  if before_id is not null then
    select m.* into v_before from public.messages m where m.id = before_id and m.conversation_id = v_conv.id;
    if not found then
      perform earth.raise('message_not_found');
    end if;
  end if;

  select array_agg(p.id order by p.created_at desc, p.id desc)
    into v_ids
    from (
      select m.id, m.created_at
        from public.messages m
       where m.conversation_id = v_conv.id
         and (v_before.id is null or (m.created_at, m.id) < (v_before.created_at, v_before.id))
       order by m.created_at desc, m.id desc
       limit v_limit + 1
    ) p;

  if coalesce(array_length(v_ids, 1), 0) > v_limit then
    v_next := v_ids[v_limit];
    v_ids := v_ids[1:v_limit];
  end if;

  select coalesce(jsonb_agg(earth.message_json(i.id, v_me) order by i.ord), '[]'::jsonb)
    into v_items
    from unnest(coalesce(v_ids, '{}'::uuid[])) with ordinality as i(id, ord);

  return jsonb_build_object('messages', v_items, 'nextCursor', v_next::text);
end
$$;

-- Polling fallback (ARCHITECTURE §8): messages after `after_id`, oldest first, at most 200;
-- `nextCursor` is the last id when more remain. With no `after_id` the newest 200 are returned.
create or replace function public.messages_since(conversation_id uuid, after_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_conv public.conversations := earth.assert_conversation_access(conversation_id, v_me);
  v_after public.messages%rowtype;
  v_ids uuid[];
  v_next uuid;
  v_items jsonb;
begin
  if after_id is not null then
    select m.* into v_after from public.messages m where m.id = after_id and m.conversation_id = v_conv.id;
    if not found then
      perform earth.raise('message_not_found');
    end if;
    select array_agg(p.id order by p.created_at, p.id)
      into v_ids
      from (
        select m.id, m.created_at
          from public.messages m
         where m.conversation_id = v_conv.id
           and (m.created_at, m.id) > (v_after.created_at, v_after.id)
         order by m.created_at, m.id
         limit 201
      ) p;
    if coalesce(array_length(v_ids, 1), 0) > 200 then
      v_next := v_ids[200];
      v_ids := v_ids[1:200];
    end if;
  else
    select array_agg(p.id order by p.created_at, p.id)
      into v_ids
      from (
        select m.id, m.created_at
          from public.messages m
         where m.conversation_id = v_conv.id
         order by m.created_at desc, m.id desc
         limit 200
      ) p;
  end if;

  select coalesce(jsonb_agg(earth.message_json(i.id, v_me) order by i.ord), '[]'::jsonb)
    into v_items
    from unnest(coalesce(v_ids, '{}'::uuid[])) with ordinality as i(id, ord);

  return jsonb_build_object('messages', v_items, 'nextCursor', v_next::text);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Writing
-- ---------------------------------------------------------------------------------------------------

create or replace function public.message_send(
  conversation_id uuid,
  client_id uuid,
  type public.message_type default 'text',
  text text default null,
  payload jsonb default '{}'::jsonb,
  reply_to_message_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_conv public.conversations := earth.assert_conversation_access(conversation_id, v_me);
  v_client uuid := client_id;
  v_type public.message_type := coalesce(type, 'text');
  v_text text := nullif(btrim(coalesce(text, '')), '');
  v_payload jsonb := coalesce(payload, '{}'::jsonb);
  v_reply uuid := reply_to_message_id;
  v_id uuid;
  v_group public.groups%rowtype;
  v_sender_name text;
  v_preview text;
  v_recipient uuid;
  v_group_name text;
begin
  if v_client is null then
    perform earth.raise('invalid_input', 'client_id is required');
  end if;

  -- Idempotent retry (spec §53, §108): the row this client id already created.
  select m.id into v_id
    from public.messages m
   where m.conversation_id = v_conv.id and m.sender_human_id = v_me and m.client_id = v_client;
  if v_id is not null then
    return earth.message_json(v_id, v_me);
  end if;

  perform earth.rate_limit_for_caller('message_send', 60, 60);

  if v_type = 'system' then
    perform earth.raise('invalid_input', 'system messages are not sent by clients');
  end if;
  if jsonb_typeof(v_payload) <> 'object' then
    perform earth.raise('invalid_input', 'payload must be an object');
  end if;
  if v_type = 'text' and v_text is null then
    perform earth.raise('invalid_input', 'text messages need text');
  end if;
  if v_text is not null and length(v_text) > 4000 then
    perform earth.raise('invalid_input', 'text is longer than 4000 characters');
  end if;
  if v_reply is not null
     and not exists (select 1 from public.messages r where r.id = v_reply and r.conversation_id = v_conv.id) then
    perform earth.raise('message_not_found', 'reply_to_message_id is not in this conversation');
  end if;

  insert into public.messages (conversation_id, sender_human_id, type, text, payload, client_id, reply_to_message_id)
  values (v_conv.id, v_me, v_type, v_text, v_payload, v_client, v_reply)
  on conflict on constraint messages_client_key do nothing
  returning id into v_id;
  if v_id is null then
    -- A concurrent retry won the insert.
    select m.id into v_id
      from public.messages m
     where m.conversation_id = v_conv.id and m.sender_human_id = v_me and m.client_id = v_client;
    return earth.message_json(v_id, v_me);
  end if;

  -- Notifications (spec §86) for members who want them; earth.notify skips blocked pairs.
  v_sender_name := coalesce(earth.display_name_of(v_me), 'Earth member');
  v_preview := earth.message_preview(v_type, v_text);
  if v_conv.type = 'group' then
    select g.* into v_group from public.groups g where g.id = v_conv.group_id;
  end if;
  for v_recipient in
    select cm.human_id
      from public.conversation_members cm
     where cm.conversation_id = v_conv.id
       and cm.human_id <> v_me
       and cm.notification_level = 'all'
       and cm.mute_state = 'none'
  loop
    if v_conv.type = 'direct' then
      perform earth.notify(
        v_recipient, 'direct_message', v_me, 'message', v_id,
        jsonb_build_object('preview', v_preview, 'conversationId', v_conv.id, 'senderName', v_sender_name)
      );
    else
      v_group_name := coalesce(
        v_group.name,
        earth.conversation_summary_json(v_conv.id, v_recipient) ->> 'title',
        'New group'
      );
      perform earth.notify(
        v_recipient, 'group_message', v_me, 'message', v_id,
        jsonb_build_object(
          'preview', v_preview, 'conversationId', v_conv.id,
          'senderName', v_sender_name, 'groupName', v_group_name
        )
      );
    end if;
  end loop;

  return earth.message_json(v_id, v_me);
end
$$;

create or replace function public.message_edit(message_id uuid, text text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_msg public.messages := earth.assert_message_access(message_id, v_me);
  v_text text := nullif(btrim(coalesce(text, '')), '');
begin
  perform earth.rate_limit_for_caller('message_edit', 120, 60);
  if v_msg.deleted_at is not null then
    perform earth.raise('message_not_found');
  end if;
  if v_msg.sender_human_id <> v_me or v_msg.type = 'system' then
    perform earth.raise('forbidden');
  end if;
  if v_text is null or length(v_text) > 4000 then
    perform earth.raise('invalid_input', 'text must be 1 to 4000 characters');
  end if;

  update public.messages m
     set text = v_text, edited_at = now()
   where m.id = v_msg.id;

  return earth.message_json(v_msg.id, v_me);
end
$$;

-- Tombstone (spec §27): the sender, or an owner/moderator of the group, may delete. Idempotent.
create or replace function public.message_delete(message_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_msg public.messages := earth.assert_message_access(message_id, v_me);
  v_conv public.conversations%rowtype;
begin
  if v_msg.deleted_at is not null then
    return earth.message_json(v_msg.id, v_me);
  end if;
  perform earth.rate_limit_for_caller('message_delete', 120, 60);
  select c.* into v_conv from public.conversations c where c.id = v_msg.conversation_id;
  if v_msg.sender_human_id <> v_me
     and not (v_conv.type = 'group' and earth.is_group_moderator(v_conv.group_id, v_me)) then
    perform earth.raise('forbidden');
  end if;

  delete from public.message_reactions mr where mr.message_id = v_msg.id;
  update public.messages m
     set deleted_at = now(), text = null, payload = '{}'::jsonb
   where m.id = v_msg.id;

  if v_msg.sender_human_id <> v_me then
    perform earth.audit(
      'message_delete', 'message', v_msg.id,
      jsonb_build_object('conversationId', v_msg.conversation_id, 'senderHumanId', v_msg.sender_human_id)
    );
  end if;
  return earth.message_json(v_msg.id, v_me);
end
$$;

-- Adds or removes the caller's reaction; unique per (message, human, reaction) (spec §28).
create or replace function public.message_reaction_toggle(message_id uuid, reaction text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_msg public.messages := earth.assert_message_access(message_id, v_me);
  v_reaction text := btrim(coalesce(reaction, ''));
  v_removed boolean;
begin
  if v_reaction = '' or length(v_reaction) > 16 then
    perform earth.raise('invalid_input', 'reaction must be 1 to 16 characters');
  end if;
  perform earth.rate_limit_for_caller('message_reaction', 120, 60);
  if v_msg.deleted_at is not null then
    perform earth.raise('message_not_found');
  end if;
  -- Interactions with a blocked Human are suppressed even inside a shared group (spec §56).
  if v_msg.sender_human_id <> v_me and earth.is_blocked_either(v_me, v_msg.sender_human_id) then
    perform earth.raise('blocked');
  end if;

  delete from public.message_reactions mr
   where mr.message_id = v_msg.id and mr.human_id = v_me and mr.reaction = v_reaction;
  v_removed := found;
  if not v_removed then
    insert into public.message_reactions (message_id, human_id, reaction)
    values (v_msg.id, v_me, v_reaction);
  end if;

  return earth.message_json(v_msg.id, v_me);
end
$$;

-- Read state (spec §55): points the member's `last_read_message_id` at `message_id` (never
-- backwards; the newest message when null) and zeroes the unread count.
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
  v_read uuid;
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

  v_read := case
              when v_target.id is null then v_current.id
              when v_current.id is null then v_target.id
              when (v_target.created_at, v_target.id) >= (v_current.created_at, v_current.id) then v_target.id
              else v_current.id
            end;

  update public.conversation_members cm
     set last_read_message_id = v_read, last_read_at = now(), unread_count = 0
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

-- ---------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------

revoke execute on function public.messages_list(uuid, uuid, integer) from public;
revoke execute on function public.messages_since(uuid, uuid) from public;
revoke execute on function public.message_send(uuid, uuid, public.message_type, text, jsonb, uuid) from public;
revoke execute on function public.message_edit(uuid, text) from public;
revoke execute on function public.message_delete(uuid) from public;
revoke execute on function public.message_reaction_toggle(uuid, text) from public;
revoke execute on function public.conversation_mark_read(uuid, uuid) from public;

grant execute on function public.messages_list(uuid, uuid, integer) to anon, authenticated, service_role;
grant execute on function public.messages_since(uuid, uuid) to anon, authenticated, service_role;
grant execute on function public.message_send(uuid, uuid, public.message_type, text, jsonb, uuid) to anon, authenticated, service_role;
grant execute on function public.message_edit(uuid, text) to anon, authenticated, service_role;
grant execute on function public.message_delete(uuid) to anon, authenticated, service_role;
grant execute on function public.message_reaction_toggle(uuid, text) to anon, authenticated, service_role;
grant execute on function public.conversation_mark_read(uuid, uuid) to anon, authenticated, service_role;

-- Internals that write stay owner/service only.
revoke execute on function earth.system_message(uuid, text, jsonb, uuid) from public, anon, authenticated;
revoke execute on function earth.system_message(uuid, uuid, text) from public, anon, authenticated;
