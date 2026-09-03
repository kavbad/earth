-- 0300 — rooms, participants, guest sessions, room invites (spec §32–35; DB_API §3; ARCHITECTURE §4, §10).
--
-- A Live is a Room whose visibility makes it discoverable (spec §36): there is no second table.
-- Rooms carry the consent state of an "Open up" (`pending_*` columns are applied only by
-- earth.room_evaluate_pending_visibility, 0310) and two trigger-maintained counters. A participant
-- is exactly one Human or one Guest session; its LiveKit identity is derived (`h:<human>` /
-- `g:<guest session>`) so the token route can never mint a foreign identity. Secrets are stored as
-- sha256 hex only. Policies and grants live in 0320; nothing here is reachable by anon/authenticated.

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  context_type public.room_context_type not null,
  context_id uuid,
  initiated_by_human_id uuid not null references public.humans (id) on delete restrict,
  visibility public.room_visibility not null,
  join_policy public.room_join_policy not null,
  status public.room_status not null default 'active',
  area_precision public.area_precision not null default 'none',
  area_id uuid references public.areas (id) on delete set null,
  place_id uuid references public.places (id) on delete set null,
  -- Requested wider visibility awaiting participant consent (ARCHITECTURE §10), with the join
  -- policy and area that will be applied together with it.
  pending_visibility public.room_visibility,
  pending_join_policy public.room_join_policy,
  pending_area_precision public.area_precision,
  pending_area_id uuid references public.areas (id) on delete set null,
  guests_disabled boolean not null default false,
  title text,
  active_human_count integer not null default 0,
  active_participant_count integer not null default 0,
  -- Set when the last active Human left (rooms_sweep ends the room after the grace period).
  humans_absent_since timestamptz,
  last_activity_at timestamptz not null default now(),
  ended_reason text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint rooms_context_check check (context_type = 'standalone' or context_id is not null),
  constraint rooms_title_check check (title is null or length(btrim(title)) between 1 and 80),
  constraint rooms_pending_visibility_check check (pending_visibility is null or pending_visibility > visibility),
  constraint rooms_pending_shape_check check (
    (pending_visibility is null) = (pending_join_policy is null)
    and (pending_visibility is not null or (pending_area_id is null and pending_area_precision is null))
  ),
  constraint rooms_counts_check check (
    active_human_count >= 0 and active_participant_count >= active_human_count
  ),
  constraint rooms_ended_check check ((status = 'ended') = (ended_at is not null)),
  constraint rooms_ended_reason_check check (ended_reason is null or length(ended_reason) between 1 and 60)
);

-- One live room per context (group / direct conversation); standalone rooms have no context id.
create unique index rooms_live_context_key on public.rooms (context_type, context_id)
  where context_id is not null and status in ('starting', 'active');
create index rooms_initiated_by_human_id_idx on public.rooms (initiated_by_human_id);
create index rooms_area_id_idx on public.rooms (area_id);
create index rooms_place_id_idx on public.rooms (place_id);
create index rooms_pending_area_id_idx on public.rooms (pending_area_id);
create index rooms_live_visibility_idx on public.rooms (visibility, started_at desc)
  where status in ('starting', 'active');
create index rooms_sweep_idx on public.rooms (humans_absent_since)
  where status in ('starting', 'active');
create index rooms_status_idx on public.rooms (status);

create trigger rooms_touch_updated_at
  before update on public.rooms
  for each row execute function earth.touch_updated_at();

create table public.room_invites (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  token_hash text not null,
  created_by_human_id uuid not null references public.humans (id) on delete cascade,
  join_policy_override public.room_join_policy,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  status text not null default 'active',
  use_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint room_invites_token_hash_key unique (token_hash),
  constraint room_invites_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint room_invites_status_check check (status in ('active', 'revoked', 'expired')),
  constraint room_invites_use_count_check check (use_count >= 0),
  constraint room_invites_revoked_check check ((status = 'revoked') = (revoked_at is not null))
);

create index room_invites_room_id_idx on public.room_invites (room_id);
create index room_invites_created_by_human_id_idx on public.room_invites (created_by_human_id);

create trigger room_invites_touch_updated_at
  before update on public.room_invites
  for each row execute function earth.touch_updated_at();

create table public.guest_sessions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  -- The anonymous Supabase user behind the Guest (ARCHITECTURE §4). Never a Human.
  auth_user_id uuid references auth.users (id) on delete set null,
  room_invite_id uuid references public.room_invites (id) on delete set null,
  display_name text not null,
  session_secret_hash text not null,
  device_fingerprint_hash text,
  -- Set by a moderator removal with `block_from_room`: this credential may not come back.
  blocked boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  removed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint guest_sessions_display_name_check check (length(btrim(display_name)) between 1 and 40),
  constraint guest_sessions_secret_hash_check check (session_secret_hash ~ '^[0-9a-f]{64}$'),
  constraint guest_sessions_fingerprint_check check (
    device_fingerprint_hash is null or length(device_fingerprint_hash) between 8 and 128
  ),
  constraint guest_sessions_expiry_check check (expires_at > created_at)
);

create index guest_sessions_room_id_idx on public.guest_sessions (room_id);
create index guest_sessions_auth_user_id_idx on public.guest_sessions (auth_user_id, room_id);
create index guest_sessions_room_invite_id_idx on public.guest_sessions (room_invite_id);
create index guest_sessions_expires_at_idx on public.guest_sessions (expires_at);

create trigger guest_sessions_touch_updated_at
  before update on public.guest_sessions
  for each row execute function earth.touch_updated_at();

create table public.room_participants (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms (id) on delete cascade,
  human_id uuid references public.humans (id) on delete cascade,
  guest_session_id uuid references public.guest_sessions (id) on delete cascade,
  role public.participant_role not null default 'participant',
  media_state public.media_state not null default 'watching',
  status public.participant_status not null default 'active',
  audience_consent_level public.room_visibility not null default 'invited',
  livekit_identity text generated always as (
    case when human_id is not null then 'h:' || human_id::text else 'g:' || guest_session_id::text end
  ) stored,
  display_name_snapshot text,
  consent_recorded_at timestamptz,
  invited_by_human_id uuid references public.humans (id) on delete set null,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint room_participants_identity_check check ((human_id is null) <> (guest_session_id is null)),
  constraint room_participants_left_check check (
    (status in ('left', 'removed')) = (left_at is not null)
  ),
  constraint room_participants_display_name_check check (
    display_name_snapshot is null or length(btrim(display_name_snapshot)) between 1 and 40
  ),
  -- Guests never moderate (spec §61) and never publish beyond the room they were linked into.
  constraint room_participants_guest_role_check check (
    guest_session_id is null or role in ('participant', 'viewer')
  )
);

-- One live row (invited / waiting / active) per Human or Guest per room; history rows may repeat.
create unique index room_participants_live_human_key on public.room_participants (room_id, human_id)
  where human_id is not null and status in ('invited', 'waiting', 'active');
create unique index room_participants_live_guest_key on public.room_participants (room_id, guest_session_id)
  where guest_session_id is not null and status in ('invited', 'waiting', 'active');
create index room_participants_room_status_idx on public.room_participants (room_id, status, joined_at);
create index room_participants_human_id_idx on public.room_participants (human_id, status);
create index room_participants_guest_session_id_idx on public.room_participants (guest_session_id);
create index room_participants_invited_by_human_id_idx on public.room_participants (invited_by_human_id);
create index room_participants_identity_idx on public.room_participants (room_id, livekit_identity);

create trigger room_participants_touch_updated_at
  before update on public.room_participants
  for each row execute function earth.touch_updated_at();

-- Device fingerprints a moderator blocked from a room (spec §81 "block session/device from room").
create table public.room_blocked_fingerprints (
  room_id uuid not null references public.rooms (id) on delete cascade,
  fingerprint_hash text not null,
  blocked_by_human_id uuid references public.humans (id) on delete set null,
  guest_session_id uuid references public.guest_sessions (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint room_blocked_fingerprints_pkey primary key (room_id, fingerprint_hash),
  constraint room_blocked_fingerprints_hash_check check (length(fingerprint_hash) between 8 and 128)
);

create index room_blocked_fingerprints_blocked_by_idx on public.room_blocked_fingerprints (blocked_by_human_id);
create index room_blocked_fingerprints_guest_session_id_idx on public.room_blocked_fingerprints (guest_session_id);

-- Earlier tables that point at rooms (DB_API §2 "FK added in 03xx").
alter table public.groups
  add constraint groups_active_room_id_fkey
  foreign key (active_room_id) references public.rooms (id) on delete set null;
alter table public.conversations
  add constraint conversations_active_room_id_fkey
  foreign key (active_room_id) references public.rooms (id) on delete set null;

alter table public.rooms enable row level security;
alter table public.room_invites enable row level security;
alter table public.guest_sessions enable row level security;
alter table public.room_participants enable row level security;
alter table public.room_blocked_fingerprints enable row level security;
