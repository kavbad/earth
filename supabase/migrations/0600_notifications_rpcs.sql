-- 0600 — notification RPCs, push queue and presence-aware dispatch (DB_API §6; ARCHITECTURE §11;
-- spec PART XIV, §40, SCREEN 23).
--
-- The `notifications` table, `notification_cooldowns` and `earth.notify(...)` come from 0190; push
-- tokens and presence from 0140. This file adds the client RPCs (`notifications_list`,
-- `notification_mark_read`, `notifications_mark_all_read`, `notifications_unread_count`) and the
-- service RPCs behind `POST /api/internal/push/dispatch` (`notifications_unsent`,
-- `notifications_mark_pushed`) plus `notifications_prune`.
--
-- Ordering (SCREEN 23 "Priority ranking"): priority rank — critical_social, high, normal, low, which
-- is exactly the declared order of `public.notification_priority` (enum-parity.test.ts pins it and
-- notifications tests assert it equals NOTIFICATION_PRIORITY_RANK) — then `created_at desc`, then
-- `id desc` as the tiebreaker. The keyset cursor is the text `<createdAt>,<id>` of the last row of
-- a page; the rank of that row is read back from the row itself, so the cursor is only valid for the
-- caller's own notifications.
--
-- Every RPC result is shaped like packages/domain/src/dto/notifications.ts: `title` and `body` are
-- rendered here from the stored payload with the exact spec §86 copy (mirror of
-- `notificationCopy` in packages/domain/src/notifications/copy.ts), because clients parse
-- `NotificationDto` with those keys required.

-- ---------------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------------

-- Sort rank of a priority (NOTIFICATION_PRIORITY_RANK): lower first. Equal to the enum's own order;
-- kept as an explicit mirror for tests and readers.
create or replace function earth.notification_priority_rank(p_priority public.notification_priority)
returns integer
language sql
immutable
strict
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select case p_priority
           when 'critical_social' then 0
           when 'high' then 1
           when 'normal' then 2
           when 'low' then 3
         end
$$;

-- Trimmed, non-empty names of a payload's `names` array (mirror of the `Names` payload schema).
create or replace function earth.notification_payload_names(p_payload jsonb)
returns text[]
language sql
immutable
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select coalesce(
    array(
      select btrim(x.value)
        from jsonb_array_elements_text(
               case when jsonb_typeof(p_payload -> 'names') = 'array' then p_payload -> 'names' else '[]'::jsonb end
             ) as x(value)
       where btrim(coalesce(x.value, '')) <> ''
    ),
    '{}'::text[]
  )
$$;

-- `{title, body}` for a notification, verbatim spec §86 (packages/domain notificationCopy). Where the
-- TypeScript mirror returns null for an unusable payload the SQL falls back to a generic name so the
-- DTO (`title` non-empty) always parses; earth.notify callers never produce such payloads.
create or replace function earth.notification_copy_json(p_type earth.notification_type, p_payload jsonb)
returns jsonb
language plpgsql
immutable
parallel safe
set search_path = public, earth, private, pg_temp
as $$
declare
  v_payload jsonb := case when jsonb_typeof(p_payload) = 'object' then p_payload else '{}'::jsonb end;
  v_name text := coalesce(nullif(btrim(v_payload ->> 'name'), ''), 'Someone');
  v_sender text := coalesce(nullif(btrim(v_payload ->> 'senderName'), ''), 'Someone');
  v_group text := coalesce(nullif(btrim(v_payload ->> 'groupName'), ''), 'Your group');
  v_preview text := coalesce(v_payload ->> 'preview', '');
  v_activity text := nullif(btrim(coalesce(v_payload ->> 'activity', '')), '');
  v_names text[] := earth.notification_payload_names(v_payload);
  v_total integer := case
                       when jsonb_typeof(v_payload -> 'total') = 'number'
                       then floor((v_payload ->> 'total')::numeric)::integer
                     end;
  v_title text;
  v_body text := '';
begin
  case p_type
    when 'direct_message' then
      -- "Xavier" + message preview
      v_title := v_sender;
      v_body := v_preview;
    when 'group_message' then
      -- "Weekend Crew" + "Maya: message preview"
      v_title := v_group;
      v_body := v_sender || ': ' || v_preview;
    when 'friend_live' then
      -- "Xavier is live" + "Cooking dinner" (or "Join them")
      v_title := earth.live_title(array[v_name], 1);
      v_body := coalesce(v_activity, 'Join them');
    when 'multi_live' then
      -- "Xavier + Maya are live" + "Join them"
      v_title := earth.live_title(v_names, greatest(coalesce(v_total, coalesce(array_length(v_names, 1), 0)), 2));
      v_body := 'Join them';
    when 'group_live' then
      -- "Weekend Crew is live" + "Xavier, Maya + 2"
      v_title := v_group || ' is live';
      v_body := earth.live_name_list(v_names, v_total);
    when 'friend_request' then
      v_title := v_name || ' wants to be friends';
    when 'friend_accepted' then
      v_title := 'You and ' || v_name || ' are friends';
    when 'follow' then
      v_title := v_name || ' followed you';
    when 'group_invitation' then
      v_title := v_name || ' brought you into ' || v_group;
  end case;
  return jsonb_build_object(
    'title', coalesce(nullif(v_title, ''), 'Friends are live'),
    'body', coalesce(v_body, '')
  );
end
$$;

-- `NotificationDto` for a row.
create or replace function earth.notification_json(p_row public.notifications)
returns jsonb
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
    'id', p_row.id,
    'type', p_row.type,
    'priority', p_row.priority,
    'actorHumanId', p_row.actor_human_id,
    'objectType', p_row.object_type,
    'objectId', p_row.object_id,
    'payload', p_row.payload,
    'readAt', to_jsonb(p_row.read_at),
    'createdAt', to_jsonb(p_row.created_at)
  ) || earth.notification_copy_json(p_row.type, p_row.payload)
$$;

-- Keyset cursor of a row: `<createdAt ISO>,<id>` (to_jsonb keeps microseconds, so it round-trips).
create or replace function earth.notification_cursor(p_created_at timestamptz, p_id uuid)
returns text
language sql
immutable
strict
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select (to_jsonb(p_created_at) #>> '{}') || ',' || p_id::text
$$;

-- The conversation a notification points at, if any: `conversation` objects directly, otherwise the
-- `conversationId` message notifications carry in their payload (mirror of the server's
-- `conversationIdOf`). Null for everything else.
create or replace function earth.notification_conversation_id(p_object_type text, p_object_id uuid, p_payload jsonb)
returns uuid
language sql
immutable
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select case
           when p_object_type = 'conversation' then p_object_id
           when (p_payload ->> 'conversationId')
                ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           then (p_payload ->> 'conversationId')::uuid
         end
$$;

-- Query path of notifications_list: the caller's rows in priority order, newest first.
create index notifications_recipient_priority_created_idx
  on public.notifications (recipient_human_id, priority, created_at desc, id desc);
-- Query paths of notifications_prune (retention by age; the unsent queue keeps its partial index).
create index notifications_created_at_idx on public.notifications (created_at);
create index notification_cooldowns_last_sent_at_idx on public.notification_cooldowns (last_sent_at);

-- ---------------------------------------------------------------------------------------------------
-- Client RPCs (Humans)
-- ---------------------------------------------------------------------------------------------------

-- `NotificationsPageDto`: priority rank, then newest first; `nextCursor` when more remain;
-- `unreadCount` of every unread row of the caller. `cursor` must come from a previous page of the
-- same caller (`invalid_input` otherwise). `limit` is clamped to 1..100.
create or replace function public.notifications_list(cursor text default null, "limit" integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_cursor text := cursor;
  v_limit integer := least(greatest(coalesce("limit", 30), 1), 100);
  v_after_created timestamptz;
  v_after_id uuid;
  v_after_priority public.notification_priority;
  v_ids uuid[];
  v_next text;
  v_items jsonb;
  v_unread integer;
begin
  if v_cursor is not null then
    if position(',' in v_cursor) = 0 then
      perform earth.raise('invalid_input', 'cursor must be <createdAt>,<id>');
    end if;
    begin
      v_after_created := split_part(v_cursor, ',', 1)::timestamptz;
      v_after_id := split_part(v_cursor, ',', 2)::uuid;
    exception
      when others then
        perform earth.raise('invalid_input', 'cursor must be <createdAt>,<id>');
    end;
    select n.priority into v_after_priority
      from public.notifications n
     where n.id = v_after_id
       and n.recipient_human_id = v_me
       and n.created_at = v_after_created;
    if v_after_priority is null then
      perform earth.raise('invalid_input', 'cursor does not point at one of your notifications');
    end if;
  end if;

  select array_agg(p.id order by p.priority, p.created_at desc, p.id desc)
    into v_ids
    from (
      select n.id, n.priority, n.created_at
        from public.notifications n
       where n.recipient_human_id = v_me
         and (
           v_after_id is null
           or n.priority > v_after_priority
           or (n.priority = v_after_priority and (n.created_at, n.id) < (v_after_created, v_after_id))
         )
       order by n.priority, n.created_at desc, n.id desc
       limit v_limit + 1
    ) p;

  if coalesce(array_length(v_ids, 1), 0) > v_limit then
    v_ids := v_ids[1:v_limit];
    select earth.notification_cursor(n.created_at, n.id) into v_next
      from public.notifications n
     where n.id = v_ids[v_limit];
  end if;

  select coalesce(jsonb_agg(earth.notification_json(n) order by i.ord), '[]'::jsonb)
    into v_items
    from unnest(coalesce(v_ids, '{}'::uuid[])) with ordinality as i(id, ord)
    join public.notifications n on n.id = i.id;

  select count(*)::integer into v_unread
    from public.notifications n
   where n.recipient_human_id = v_me and n.read_at is null;

  return jsonb_build_object('notifications', v_items, 'nextCursor', v_next, 'unreadCount', v_unread);
end
$$;

-- `{ unreadCount }` for the caller (badge counts without a page).
create or replace function public.notifications_unread_count()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
begin
  return jsonb_build_object(
    'unreadCount',
    (select count(*)::integer from public.notifications n where n.recipient_human_id = v_me and n.read_at is null)
  );
end
$$;

-- Marks one of the caller's notifications read (idempotent: `readAt` keeps its first value) and
-- returns its `NotificationDto`. `not_visible` when the row is not the caller's.
create or replace function public.notification_mark_read(id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_id uuid := id;
  v_row public.notifications%rowtype;
begin
  if v_id is null then
    perform earth.raise('invalid_input', 'id is required');
  end if;
  perform earth.rate_limit_for_caller('notification_mark_read', 600, 3600);

  update public.notifications n
     set read_at = earth.utc_now()
   where n.id = v_id
     and n.recipient_human_id = v_me
     and n.read_at is null
  returning n.* into v_row;
  if not found then
    select n.* into v_row
      from public.notifications n
     where n.id = v_id and n.recipient_human_id = v_me;
    if not found then
      perform earth.raise('not_visible');
    end if;
  end if;

  return earth.notification_json(v_row);
end
$$;

-- Marks every unread notification of the caller read: `{ markedCount, unreadCount: 0 }`.
create or replace function public.notifications_mark_all_read()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_marked integer;
begin
  perform earth.rate_limit_for_caller('notifications_mark_all_read', 120, 3600);

  update public.notifications n
     set read_at = earth.utc_now()
   where n.recipient_human_id = v_me
     and n.read_at is null;
  get diagnostics v_marked = row_count;

  return jsonb_build_object('markedCount', v_marked, 'unreadCount', 0);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Service RPCs (push dispatcher, retention)
-- ---------------------------------------------------------------------------------------------------

-- The oldest `limit` (1..2000) notifications not yet pushed, each with the recipient's push tokens
-- and presence, as an array of rows for the dispatcher (packages/server push/messages.ts
-- `UnsentNotificationRowSchema`):
--   { id, recipientHumanId, type, priority, actorHumanId, objectType, objectId, payload, createdAt,
--     pushTokens: [{ token, platform }], presence: { lastActiveAt, activeConversationId, activeRoomId } | null }
-- Presence-aware dispatch (ARCHITECTURE §11): a recipient active within the last 30 s whose
-- `active_conversation_id` is the notification's conversation is looking at it already; those rows
-- are excluded from the result and marked `push_sent_at` (handled without a push) so a later run
-- never pushes a message the recipient has already seen. Rows without tokens are returned with an
-- empty `pushTokens` array; the dispatcher marks them.
create or replace function public.notifications_unsent("limit" integer default 500)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce("limit", 500), 1), 2000);
  v_now timestamptz := earth.utc_now();
  v_window interval := make_interval(secs => 30);
  v_ids uuid[];
  v_rows jsonb;
begin
  if earth.current_role_kind() <> 'service' then
    perform earth.raise('forbidden');
  end if;

  select array_agg(b.id)
    into v_ids
    from (
      select n.id
        from public.notifications n
       where n.push_sent_at is null
       order by n.created_at, n.id
       limit v_limit
    ) b;
  if v_ids is null then
    return '[]'::jsonb;
  end if;

  update public.notifications n
     set push_sent_at = v_now
    from public.human_presence hp
   where n.id = any (v_ids)
     and n.push_sent_at is null
     and hp.human_id = n.recipient_human_id
     and hp.active_conversation_id is not null
     and hp.last_active_at >= v_now - v_window
     and hp.last_active_at <= v_now
     and hp.active_conversation_id = earth.notification_conversation_id(n.object_type, n.object_id, n.payload);

  select coalesce(jsonb_agg(r.row_json order by r.created_at, r.id), '[]'::jsonb)
    into v_rows
    from (
      select n.created_at,
             n.id,
             jsonb_build_object(
               'id', n.id,
               'recipientHumanId', n.recipient_human_id,
               'type', n.type,
               'priority', n.priority,
               'actorHumanId', n.actor_human_id,
               'objectType', n.object_type,
               'objectId', n.object_id,
               'payload', n.payload,
               'createdAt', to_jsonb(n.created_at),
               'pushTokens', coalesce(
                 (select jsonb_agg(jsonb_build_object('token', pt.token, 'platform', pt.platform)
                                   order by pt.created_at, pt.token)
                    from public.push_tokens pt
                   where pt.human_id = n.recipient_human_id),
                 '[]'::jsonb
               ),
               'presence', (
                 select jsonb_build_object(
                          'lastActiveAt', to_jsonb(hp.last_active_at),
                          'activeConversationId', hp.active_conversation_id,
                          'activeRoomId', hp.active_room_id
                        )
                   from public.human_presence hp
                  where hp.human_id = n.recipient_human_id
               )
             ) as row_json
        from public.notifications n
       where n.id = any (v_ids)
         and n.push_sent_at is null
    ) r;

  return v_rows;
end
$$;

-- Marks the given notifications pushed: `push_sent_at` is set once and never moved
-- (`{ markedCount }` counts the rows that were still unsent).
create or replace function public.notifications_mark_pushed(ids uuid[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_ids uuid[] := array(select distinct x.id from unnest(coalesce(ids, '{}'::uuid[])) as x(id) where x.id is not null);
  v_marked integer := 0;
begin
  if earth.current_role_kind() <> 'service' then
    perform earth.raise('forbidden');
  end if;
  if coalesce(array_length(v_ids, 1), 0) > 0 then
    update public.notifications n
       set push_sent_at = earth.utc_now()
     where n.id = any (v_ids)
       and n.push_sent_at is null;
    get diagnostics v_marked = row_count;
  end if;
  return jsonb_build_object('markedCount', v_marked);
end
$$;

-- Retention: deletes notifications created more than `days` (>= 1, default 90) ago and Live
-- cooldown rows whose last send is as old — `{ deleted, cooldownsDeleted }`.
create or replace function public.notifications_prune(days integer default 90)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_days integer := days;
  v_before timestamptz;
  v_deleted integer;
  v_cooldowns integer;
begin
  if earth.current_role_kind() <> 'service' then
    perform earth.raise('forbidden');
  end if;
  if v_days is null or v_days < 1 then
    perform earth.raise('invalid_input', 'days must be at least 1');
  end if;
  v_before := earth.utc_now() - make_interval(days => v_days);

  delete from public.notifications n where n.created_at < v_before;
  get diagnostics v_deleted = row_count;
  delete from public.notification_cooldowns nc where nc.last_sent_at < v_before;
  get diagnostics v_cooldowns = row_count;

  return jsonb_build_object('deleted', v_deleted, 'cooldownsDeleted', v_cooldowns);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------

revoke execute on function public.notifications_list(text, integer) from public;
revoke execute on function public.notifications_unread_count() from public;
revoke execute on function public.notification_mark_read(uuid) from public;
revoke execute on function public.notifications_mark_all_read() from public;
revoke execute on function public.notifications_unsent(integer) from public;
revoke execute on function public.notifications_mark_pushed(uuid[]) from public;
revoke execute on function public.notifications_prune(integer) from public;

-- Client RPCs: every API role may call them so the caller-state errors surface as machine codes.
grant execute on function public.notifications_list(text, integer) to anon, authenticated, service_role;
grant execute on function public.notifications_unread_count() to anon, authenticated, service_role;
grant execute on function public.notification_mark_read(uuid) to anon, authenticated, service_role;
grant execute on function public.notifications_mark_all_read() to anon, authenticated, service_role;

-- Service RPCs: the server tier only.
grant execute on function public.notifications_unsent(integer) to service_role;
grant execute on function public.notifications_mark_pushed(uuid[]) to service_role;
grant execute on function public.notifications_prune(integer) to service_role;

-- Helpers reachable from policies stay read-only; nothing here mutates, so the schema defaults apply.
