-- 0190 — notifications primitive (spec §40, §86; ARCHITECTURE §11; DB_API §6 table only).
--
-- `earth.notify(...)` is the single way a notification row is created, called from the RPC that
-- caused it. It never notifies the actor themself, never crosses a block, and never targets a Human
-- who is not active. Priority defaults to the domain mapping (`NOTIFICATION_PRIORITY_BY_TYPE` in
-- packages/domain/src/notifications/dedupe.ts). `notification_cooldowns` backs the Live dedupe rule
-- of ARCHITECTURE §11 (rows written by `earth.notify_live` in 03xx).
--
-- `notification_type` is a Postgres enum with exactly the domain's `NOTIFICATION_TYPES`; it lives in
-- schema `earth` because the domain package mirrors only the `public` enums (ENUM_REGISTRY, checked by
-- enum-parity.test.ts) and lists notification types as a supplementary tuple. Clients read and filter
-- the column with plain literals; only naming the type needs schema USAGE.

create type earth.notification_type as enum (
  'direct_message',
  'group_message',
  'friend_live',
  'multi_live',
  'group_live',
  'friend_request',
  'friend_accepted',
  'follow',
  'group_invitation'
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_human_id uuid not null references public.humans (id) on delete cascade,
  type earth.notification_type not null,
  actor_human_id uuid references public.humans (id) on delete set null,
  object_type text not null,
  object_id uuid not null,
  payload jsonb not null default '{}'::jsonb,
  priority public.notification_priority not null,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  push_sent_at timestamptz,
  constraint notifications_object_type_check check (
    object_type in ('human', 'group', 'conversation', 'message', 'room', 'post')
  ),
  constraint notifications_payload_check check (jsonb_typeof(payload) = 'object')
);

create index notifications_recipient_created_idx on public.notifications (recipient_human_id, created_at desc);
create index notifications_recipient_unread_idx on public.notifications (recipient_human_id) where read_at is null;
create index notifications_unsent_idx on public.notifications (created_at) where push_sent_at is null;
create index notifications_actor_human_id_idx on public.notifications (actor_human_id);
create index notifications_object_idx on public.notifications (object_type, object_id);

alter table public.notifications enable row level security;
grant select on table public.notifications to authenticated;
create policy notifications_select_own on public.notifications
  for select to authenticated
  using (recipient_human_id = earth.current_human());

create table public.notification_cooldowns (
  recipient_human_id uuid not null references public.humans (id) on delete cascade,
  room_id uuid not null,
  last_sent_at timestamptz not null default now(),
  sends_in_window integer not null default 1,
  notified_participant_ids uuid[] not null default '{}'::uuid[],
  constraint notification_cooldowns_pkey primary key (recipient_human_id, room_id),
  constraint notification_cooldowns_sends_check check (sends_in_window >= 0)
);

create index notification_cooldowns_room_id_idx on public.notification_cooldowns (room_id);

alter table public.notification_cooldowns enable row level security;

-- Domain priority per type (NOTIFICATION_PRIORITY_BY_TYPE).
create or replace function earth.notification_priority_for(type text)
returns public.notification_priority
language sql
immutable
strict
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select case type
           when 'friend_live' then 'critical_social'
           when 'multi_live' then 'critical_social'
           when 'group_live' then 'critical_social'
           when 'direct_message' then 'high'
           when 'friend_request' then 'high'
           when 'friend_accepted' then 'high'
           when 'group_invitation' then 'high'
           when 'group_message' then 'normal'
           when 'follow' then 'low'
         end::public.notification_priority
$$;

-- Inserts a notification and returns its id, or null when skipped (self, blocked either way,
-- recipient missing or not active). `type` must be a domain notification type (`invalid_input`).
create or replace function earth.notify(
  recipient uuid,
  type text,
  actor uuid,
  object_type text,
  object_id uuid,
  payload jsonb default '{}'::jsonb,
  priority public.notification_priority default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_type earth.notification_type;
  v_priority public.notification_priority;
  v_id uuid;
begin
  if type is null or not (type = any (enum_range(null::earth.notification_type)::text[])) then
    perform earth.raise('invalid_input', 'earth.notify: unknown notification type ' || coalesce(type, 'null'));
  end if;
  if object_type is null or object_id is null then
    perform earth.raise('invalid_input', 'earth.notify: object_type and object_id are required');
  end if;
  if recipient is null or recipient = actor then
    return null;
  end if;
  if not exists (select 1 from public.humans h where h.id = recipient and h.status = 'active') then
    return null;
  end if;
  if actor is not null and earth.is_blocked_either(recipient, actor) then
    return null;
  end if;

  v_type := type::earth.notification_type;
  v_priority := coalesce(priority, earth.notification_priority_for(type));

  insert into public.notifications (recipient_human_id, type, actor_human_id, object_type, object_id, payload, priority)
  values (recipient, v_type, actor, object_type, object_id, coalesce(payload, '{}'::jsonb), v_priority)
  returning id into v_id;
  return v_id;
end
$$;

revoke execute on function earth.notify(uuid, text, uuid, text, uuid, jsonb, public.notification_priority)
  from public, anon, authenticated;

-- Realtime: notifications are delivered through the supabase_realtime publication (RLS governs rows).
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end
$$;
