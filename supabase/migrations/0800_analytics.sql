-- 0800 — first-party analytics events and RTC diagnostics (spec §13, §96–§97, §109; DB_API §8).
--
-- `analytics_events` is the first-party event sink behind `POST /api/analytics/ingest`: every
-- caller kind writes through `analytics_track(events)`, which whitelists event names (exactly
-- `EVENT_NAMES` in packages/analytics/src/contract.ts — the database tests assert parity), takes
-- the identity from the credential (a client-supplied `humanId` is never trusted, a Guest session is
-- attached only when it belongs to the caller), strips anything that names or reads like a GPS
-- coordinate (spec §96), caps a batch at 50 events and charges one rate-limit unit per event
-- (600 per 10 minutes for Humans, half for Guests and Visitors). `rtc_diagnostics` is the sink of
-- `POST /api/diagnostics/rtc` through `rtc_diagnostic_record`. The service role inserts into both
-- tables directly. Clients never read either table (0820).
--
-- Enumerations here are `text` with check constraints on purpose: the only Postgres enum types are
-- the spec's (ARCHITECTURE §5), mirrored one-to-one by `ENUM_REGISTRY` and asserted by the enum
-- parity test; `platform` mirrors `ANALYTICS_PLATFORMS` (packages/analytics/src/identity.ts).

-- ---------------------------------------------------------------------------------------------------
-- Event name whitelist (spec §97, in spec order; = EVENT_NAMES)
-- ---------------------------------------------------------------------------------------------------

create or replace function earth.analytics_event_names()
returns text[]
language sql
immutable
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select array[
    -- membership
    'public_world_viewed', 'claim_started', 'claim_group_join_selected', 'claim_group_start_selected',
    'human_verification_started', 'human_verification_passed', 'human_verification_failed',
    'human_claimed', 'account_recovery_started',
    -- groups
    'group_created', 'group_invite_shared', 'group_invite_opened', 'group_joined', 'group_left',
    'second_group_joined',
    -- messaging
    'message_sent', 'message_received', 'message_replied', 'reaction_added', 'voice_message_sent',
    'media_message_sent',
    -- live
    'room_created', 'room_joined', 'room_left', 'camera_enabled', 'audio_joined',
    'room_visibility_changed', 'live_card_impression', 'live_card_opened', 'live_join_requested',
    'participant_consent_shown', 'participant_consent_accepted', 'guest_room_opened', 'guest_joined',
    'guest_room_completed',
    -- feed
    'feed_opened', 'scope_changed', 'post_impression', 'post_opened', 'post_created', 'post_reacted',
    'post_replied', 'post_hidden',
    -- social
    'friend_requested', 'friend_accepted', 'follow_created', 'profile_viewed', 'search_performed',
    -- safety
    'human_blocked', 'content_reported', 'room_participant_removed', 'guest_removed'
  ]::text[]
$$;

create or replace function earth.analytics_event_name_allowed(p_name text)
returns boolean
language sql
immutable
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select p_name is not null and p_name = any (earth.analytics_event_names())
$$;

-- `ANALYTICS_PLATFORMS` (packages/analytics/src/identity.ts).
create or replace function earth.analytics_platform_allowed(p_platform text)
returns boolean
language sql
immutable
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select coalesce(p_platform in ('ios', 'android', 'web', 'server'), false)
$$;

-- ---------------------------------------------------------------------------------------------------
-- Coordinate guard (spec §96; mirror of packages/analytics/src/guard.ts)
-- ---------------------------------------------------------------------------------------------------

-- Word tokens of a property key: split on `_`, `-`, `.`, whitespace, camelCase and letter/digit
-- boundaries, lower-cased. `userLat` → {user, lat}; `deliveryLatencyMs` → {delivery, latency, ms}.
create or replace function earth.analytics_key_tokens(p_key text)
returns text[]
language sql
immutable
strict
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select array_remove(
    regexp_split_to_array(
      lower(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(p_key, '([a-z0-9])([A-Z])', '\1 \2', 'g'),
              '([A-Z]+)([A-Z][a-z])', '\1 \2', 'g'),
            '([A-Za-z])([0-9])', '\1 \2', 'g'),
          '([0-9])([A-Za-z])', '\1 \2', 'g')
      ),
      '[[:space:]_.-]+'
    ),
    ''
  )
$$;

-- A key names a coordinate when any of its tokens is a coordinate word (`FORBIDDEN_PROPERTY_TOKENS`
-- plus `location`).
create or replace function earth.analytics_forbidden_key(p_key text)
returns boolean
language sql
immutable
strict
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select exists (
    select 1
      from unnest(earth.analytics_key_tokens(p_key)) as t(token)
     where t.token in (
       'lat', 'lng', 'lon', 'latitude', 'longitude', 'latlng', 'latlon', 'lnglat', 'lonlat',
       'coord', 'coords', 'coordinate', 'coordinates', 'gps', 'geo', 'geohash', 'geolocation',
       'geopoint', 'geometry', 'altitude', 'location'
     )
  )
$$;

-- A string that reads as an exact `lat,lng` pair (three or more decimals each, optional `geo:`
-- prefix, either order, both within range), whatever its key is called.
create or replace function earth.analytics_coordinate_like(p_value jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = public, earth, private, pg_temp
as $$
declare
  v_match text[];
  v_a numeric;
  v_b numeric;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string' then
    return false;
  end if;
  v_match := regexp_match(
    p_value #>> '{}',
    '^\s*(?:geo:)?\s*([-+]?\d{1,3}\.\d{3,})\s*,\s*([-+]?\d{1,3}\.\d{3,})\s*$'
  );
  if v_match is null then
    return false;
  end if;
  v_a := v_match[1]::numeric;
  v_b := v_match[2]::numeric;
  return (abs(v_a) <= 90 and abs(v_b) <= 180) or (abs(v_a) <= 180 and abs(v_b) <= 90);
end
$$;

-- A leaf is forbidden when it is coordinate-like or an array holding a coordinate-like item.
create or replace function earth.analytics_forbidden_leaf(p_value jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select earth.analytics_coordinate_like(p_value)
      or (jsonb_typeof(p_value) = 'array' and exists (
            select 1 from jsonb_array_elements(p_value) as a(item)
             where earth.analytics_coordinate_like(a.item)))
$$;

-- A copy of `p_value` without forbidden keys and coordinate-like values, recursively through nested
-- objects and arrays (the wire format is flat, but nothing geographic may land in the table however
-- it arrived).
create or replace function earth.analytics_strip_coordinates(p_value jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_type text := jsonb_typeof(p_value);
begin
  if v_type = 'object' then
    return coalesce(
      (select jsonb_object_agg(e.key, earth.analytics_strip_coordinates(e.value))
         from jsonb_each(p_value) as e
        where not earth.analytics_forbidden_key(e.key)
          and not earth.analytics_forbidden_leaf(e.value)),
      '{}'::jsonb
    );
  elsif v_type = 'array' then
    return coalesce(
      (select jsonb_agg(earth.analytics_strip_coordinates(a.item) order by a.ord)
         from jsonb_array_elements(p_value) with ordinality as a(item, ord)),
      '[]'::jsonb
    );
  end if;
  return p_value;
end
$$;

-- Canonical uuid text → uuid, null for anything else (never raises).
create or replace function earth.try_uuid(p_text text)
returns uuid
language sql
immutable
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select case
           when p_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_text::uuid
           else null
         end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------------

create table public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  human_id uuid references public.humans (id) on delete set null,
  anonymous_visitor_id uuid,
  guest_session_id uuid references public.guest_sessions (id) on delete set null,
  name text not null,
  properties jsonb not null default '{}'::jsonb,
  platform text not null,
  app_version text not null,
  -- The instant the event happened on the device (`timestamp`, spec §96); `created_at` is receipt.
  client_timestamp timestamptz,
  created_at timestamptz not null default now(),
  constraint analytics_events_name_check check (earth.analytics_event_name_allowed(name)),
  constraint analytics_events_properties_check check (jsonb_typeof(properties) = 'object'),
  constraint analytics_events_platform_check check (earth.analytics_platform_allowed(platform)),
  constraint analytics_events_app_version_check check (length(app_version) between 1 and 64)
);

create index analytics_events_name_created_at_idx on public.analytics_events (name, created_at);
create index analytics_events_human_id_idx on public.analytics_events (human_id);
create index analytics_events_guest_session_id_idx on public.analytics_events (guest_session_id);
create index analytics_events_anonymous_visitor_id_idx on public.analytics_events (anonymous_visitor_id)
  where anonymous_visitor_id is not null;
create index analytics_events_created_at_idx on public.analytics_events (created_at);

create table public.rtc_diagnostics (
  id uuid primary key default gen_random_uuid(),
  human_id uuid references public.humans (id) on delete set null,
  guest_session_id uuid references public.guest_sessions (id) on delete set null,
  room_id uuid references public.rooms (id) on delete set null,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- `RTC_DIAGNOSTIC_KINDS` (packages/observability/src/rtc.ts) are snake_case identifiers; the
  -- server validates the envelope, the database keeps the shape.
  constraint rtc_diagnostics_kind_check check (kind ~ '^[a-z][a-z0-9_]*$' and length(kind) <= 64),
  constraint rtc_diagnostics_payload_check check (jsonb_typeof(payload) = 'object')
);

create index rtc_diagnostics_room_id_idx on public.rtc_diagnostics (room_id);
create index rtc_diagnostics_human_id_idx on public.rtc_diagnostics (human_id);
create index rtc_diagnostics_guest_session_id_idx on public.rtc_diagnostics (guest_session_id);
create index rtc_diagnostics_kind_created_at_idx on public.rtc_diagnostics (kind, created_at);

alter table public.analytics_events enable row level security;
alter table public.rtc_diagnostics enable row level security;

-- ---------------------------------------------------------------------------------------------------
-- RPC helpers
-- ---------------------------------------------------------------------------------------------------

-- A reserved event field: the top-level key wins, then the same key inside `properties` (the client
-- merges identity and base properties into the envelope, packages/analytics/src/client.ts).
create or replace function earth.analytics_event_field(
  p_event jsonb,
  p_properties jsonb,
  p_key text,
  p_property_key text default null
)
returns jsonb
language sql
immutable
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select coalesce(
    nullif(p_event -> p_key, 'null'::jsonb),
    nullif(p_properties -> coalesce(p_property_key, p_key), 'null'::jsonb)
  )
$$;

-- The text of a string field, or raises `invalid_input` when present with another type.
create or replace function earth.analytics_text_field(p_value jsonb, p_field text, p_index integer)
returns text
language plpgsql
immutable
set search_path = public, earth, private, pg_temp
as $$
begin
  if p_value is null then
    return null;
  end if;
  if jsonb_typeof(p_value) <> 'string' then
    perform earth.raise('invalid_input', format('event %s: %s must be a string', p_index, p_field));
  end if;
  return p_value #>> '{}';
end
$$;

-- A uuid field, or raises `invalid_input` when present and not a canonical uuid.
create or replace function earth.analytics_uuid_field(p_value jsonb, p_field text, p_index integer)
returns uuid
language plpgsql
immutable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_text text := earth.analytics_text_field(p_value, p_field, p_index);
  v_uuid uuid;
begin
  if v_text is null then
    return null;
  end if;
  v_uuid := earth.try_uuid(v_text);
  if v_uuid is null then
    perform earth.raise('invalid_input', format('event %s: %s must be a uuid', p_index, p_field));
  end if;
  return v_uuid;
end
$$;

-- A timestamp field (ISO-8601 with offset), or raises `invalid_input` when unparseable.
create or replace function earth.analytics_timestamp_field(p_value jsonb, p_field text, p_index integer)
returns timestamptz
language plpgsql
stable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_text text := earth.analytics_text_field(p_value, p_field, p_index);
begin
  if v_text is null then
    return null;
  end if;
  begin
    return v_text::timestamptz;
  exception
    when invalid_datetime_format or datetime_field_overflow or invalid_text_representation then
      perform earth.raise('invalid_input', format('event %s: %s must be an ISO-8601 instant', p_index, p_field));
  end;
  return null;
end
$$;

-- The latest Guest session of the caller in a room, whatever its expiry (a Guest reports what
-- happened in a room after leaving it, when the session may already have expired).
create or replace function earth.analytics_caller_guest_session(p_room_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select gs.id
    from public.guest_sessions gs
   where p_room_id is not null
     and auth.uid() is not null
     and earth.is_anonymous_jwt()
     and gs.room_id = p_room_id
     and gs.auth_user_id = auth.uid()
   order by gs.created_at desc, gs.id
   limit 1
$$;

-- ---------------------------------------------------------------------------------------------------
-- analytics_track(events jsonb) — any caller (DB_API §8)
-- ---------------------------------------------------------------------------------------------------
-- `events` is a JSON array of at most 50 envelopes:
--   { name, properties?, platform?, appVersion?, anonymousVisitorId?, guestSessionId?, clientTimestamp? }
-- `platform` and `appVersion` may also arrive inside `properties` (client merge); `clientTimestamp`
-- falls back to `properties.timestamp`. Identity: `human_id` is always the caller's own Human
-- (pending or active — the claim funnel is tracked by Claiming Humans), never a supplied value;
-- `guest_session_id` is the supplied session only when it belongs to the caller, else the caller's
-- session in `properties.roomId`, else null. Reserved base/identity keys are removed from the stored
-- properties (`guestSessionId` stays: guest_* events legitimately name another person's session)
-- and coordinates are stripped. Returns `{ accepted }`. Errors: `invalid_input`, `rate_limited`.
create or replace function public.analytics_track(events jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_uid uuid := auth.uid();
  v_human uuid := earth.current_human_id();
  v_count integer;
  v_index integer := 0;
  v_event jsonb;
  v_name text;
  v_props jsonb;
  v_platform text;
  v_version text;
  v_visitor uuid;
  v_guest uuid;
  v_room uuid;
  v_client_ts timestamptz;
  v_accepted integer := 0;
begin
  if events is null or jsonb_typeof(events) <> 'array' then
    perform earth.raise('invalid_input', 'events must be a JSON array');
  end if;
  v_count := jsonb_array_length(events);
  if v_count = 0 then
    perform earth.raise('invalid_input', 'events must not be empty');
  end if;
  if v_count > 50 then
    perform earth.raise('invalid_input', format('at most 50 events per call (got %s)', v_count));
  end if;

  -- One unit per event: 600 events per 10 minutes for Humans, half for Guests and Visitors, never
  -- for the service. A refused batch rolls back entirely, including its own units.
  for i in 1..v_count loop
    perform earth.rate_limit_for_caller('analytics_track', 600, 600);
  end loop;

  for v_event in select a.item from jsonb_array_elements(events) as a(item) loop
    v_index := v_index + 1;
    if jsonb_typeof(v_event) <> 'object' then
      perform earth.raise('invalid_input', format('event %s: must be an object', v_index));
    end if;

    v_name := earth.analytics_text_field(v_event -> 'name', 'name', v_index);
    if not earth.analytics_event_name_allowed(v_name) then
      perform earth.raise('invalid_input', format('event %s: unknown event name', v_index));
    end if;

    v_props := coalesce(v_event -> 'properties', '{}'::jsonb);
    if jsonb_typeof(v_props) <> 'object' then
      perform earth.raise('invalid_input', format('event %s: properties must be an object', v_index));
    end if;
    if (select count(*) from jsonb_object_keys(v_props)) > 64 then
      perform earth.raise('invalid_input', format('event %s: at most 64 properties', v_index));
    end if;

    v_platform := earth.analytics_text_field(
      earth.analytics_event_field(v_event, v_props, 'platform'), 'platform', v_index);
    if not earth.analytics_platform_allowed(v_platform) then
      perform earth.raise('invalid_input', format('event %s: platform must be one of ios, android, web, server', v_index));
    end if;

    v_version := earth.analytics_text_field(
      earth.analytics_event_field(v_event, v_props, 'appVersion'), 'appVersion', v_index);
    if v_version is null or length(v_version) not between 1 and 64 then
      perform earth.raise('invalid_input', format('event %s: appVersion must be 1 to 64 characters', v_index));
    end if;

    v_visitor := earth.analytics_uuid_field(
      earth.analytics_event_field(v_event, v_props, 'anonymousVisitorId'), 'anonymousVisitorId', v_index);
    v_client_ts := earth.analytics_timestamp_field(
      earth.analytics_event_field(v_event, v_props, 'clientTimestamp', 'timestamp'), 'clientTimestamp', v_index);

    -- Guest session: only the caller's own. `properties.roomId` names the room the event is about.
    v_guest := null;
    if v_kind = 'guest' then
      v_guest := earth.analytics_uuid_field(
        earth.analytics_event_field(v_event, v_props, 'guestSessionId'), 'guestSessionId', v_index);
      if v_guest is not null and not exists (
        select 1 from public.guest_sessions gs where gs.id = v_guest and gs.auth_user_id = v_uid
      ) then
        v_guest := null;
      end if;
      if v_guest is null then
        v_room := earth.try_uuid(v_props ->> 'roomId');
        v_guest := earth.analytics_caller_guest_session(v_room);
      end if;
    end if;

    v_props := earth.analytics_strip_coordinates(
      v_props - 'humanId' - 'anonymousVisitorId' - 'appVersion' - 'platform' - 'timestamp'
    );

    insert into public.analytics_events (
      human_id, anonymous_visitor_id, guest_session_id, name, properties, platform, app_version, client_timestamp
    )
    values (v_human, v_visitor, v_guest, v_name, v_props, v_platform, v_version, v_client_ts);
    v_accepted := v_accepted + 1;
  end loop;

  return jsonb_build_object('accepted', v_accepted);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- rtc_diagnostic_record(kind, room_id, payload) — Humans and Guests (DB_API §8)
-- ---------------------------------------------------------------------------------------------------
-- `room_id` may be null (a failure before any room, e.g. `network_unavailable`); when given, the
-- room must exist (`room_not_found`) and the caller must have been in it: a participant row of any
-- status for a Human, a Guest session of the room for a Guest (`not_in_room`) — a failed reconnect
-- after the session expired is exactly what gets reported. Payload keys/values that name or read
-- like coordinates are stripped. Returns `{ id, createdAt }`.
create or replace function public.rtc_diagnostic_record(
  kind text,
  room_id uuid default null,
  payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_role text := earth.current_role_kind();
  v_kind text := nullif(btrim(coalesce(kind, '')), '');
  v_payload jsonb := coalesce(payload, '{}'::jsonb);
  v_human uuid;
  v_guest uuid;
  v_id uuid;
  v_created_at timestamptz;
begin
  if v_role = 'visitor' then
    perform earth.raise('not_authenticated');
  elsif v_role = 'service' then
    perform earth.raise('forbidden', 'the service inserts rtc_diagnostics directly');
  elsif v_role = 'claiming' then
    perform earth.raise('not_a_human');
  end if;

  perform earth.rate_limit_for_caller('rtc_diagnostic_record', 120, 600);

  if v_kind is null or v_kind !~ '^[a-z][a-z0-9_]*$' or length(v_kind) > 64 then
    perform earth.raise('invalid_input', 'kind must be a snake_case identifier of at most 64 characters');
  end if;
  if jsonb_typeof(v_payload) <> 'object' then
    perform earth.raise('invalid_input', 'payload must be an object');
  end if;
  if (select count(*) from jsonb_object_keys(v_payload)) > 64 then
    perform earth.raise('invalid_input', 'payload carries at most 64 keys');
  end if;
  if octet_length(v_payload::text) > 16384 then
    perform earth.raise('invalid_input', 'payload is larger than 16 KiB');
  end if;

  if v_role = 'human' then
    v_human := earth.assert_human();
  end if;

  if room_id is not null then
    if not exists (select 1 from public.rooms r where r.id = room_id) then
      perform earth.raise('room_not_found');
    end if;
    if v_role = 'human' then
      if not exists (
        select 1 from public.room_participants rp where rp.room_id = rtc_diagnostic_record.room_id and rp.human_id = v_human
      ) then
        perform earth.raise('not_in_room');
      end if;
    else
      v_guest := earth.analytics_caller_guest_session(room_id);
      if v_guest is null then
        perform earth.raise('not_in_room');
      end if;
    end if;
  end if;

  insert into public.rtc_diagnostics (human_id, guest_session_id, room_id, kind, payload)
  values (v_human, v_guest, room_id, v_kind, earth.analytics_strip_coordinates(v_payload))
  returning id, created_at into v_id, v_created_at;

  return jsonb_build_object('id', v_id, 'createdAt', to_jsonb(v_created_at));
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------

revoke execute on function public.analytics_track(jsonb) from public;
revoke execute on function public.rtc_diagnostic_record(text, uuid, jsonb) from public;
grant execute on function public.analytics_track(jsonb) to anon, authenticated, service_role;
grant execute on function public.rtc_diagnostic_record(text, uuid, jsonb) to anon, authenticated, service_role;

-- The Guest-session lookup reveals session ids: owner and service only (0002 grants new earth.*
-- functions to the API roles by default; the pure helpers above may stay callable from policies).
revoke execute on function earth.analytics_caller_guest_session(uuid) from public, anon, authenticated;
