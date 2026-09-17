-- 0120 — identity tables (spec §16–19, §48, §79; DB_API §1; ARCHITECTURE §4).
--
-- A credential (auth.users) is never a Human: `humans.auth_user_id` links exactly one auth user to
-- one Human (unique), the claim state lives on the pending Human row, and Human Pass provider data
-- is split so `public.human_passes` never carries `metadata_private` (private.human_pass_metadata).
-- Policies and grants are in 0170; nothing here is reachable by anon/authenticated until then.

create table public.humans (
  id uuid primary key default gen_random_uuid(),
  status public.human_status not null default 'pending',
  human_pass_status public.human_pass_status not null default 'unverified',
  auth_user_id uuid references auth.users (id) on delete set null,
  claim_intent text,
  claim_group_label text,
  claim_invite_token_hash text,
  is_fixture boolean not null default false,
  created_at timestamptz not null default now(),
  claimed_at timestamptz,
  deleted_at timestamptz,
  last_active_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint humans_auth_user_id_key unique (auth_user_id),
  constraint humans_claim_intent_check check (claim_intent is null or claim_intent in ('start_group', 'join_group')),
  constraint humans_claim_group_label_check check (
    claim_group_label is null or length(btrim(claim_group_label)) between 1 and 60
  ),
  constraint humans_claim_invite_token_hash_check check (
    claim_invite_token_hash is null or claim_invite_token_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint humans_claimed_when_active check (status = 'pending' or claimed_at is not null)
);

create index humans_status_idx on public.humans (status);
create index humans_claim_invite_token_hash_idx on public.humans (claim_invite_token_hash)
  where claim_invite_token_hash is not null;

create trigger humans_touch_updated_at
  before update on public.humans
  for each row execute function earth.touch_updated_at();

create table public.public_identities (
  human_id uuid primary key references public.humans (id) on delete cascade,
  display_name text not null,
  handle text not null,
  bio text,
  avatar_media_id uuid references public.media_objects (id) on delete set null,
  home_city_area_id uuid references public.areas (id) on delete set null,
  public_city_visibility boolean not null default false,
  profile_visibility public.profile_visibility not null default 'public',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint public_identities_display_name_check check (length(btrim(display_name)) between 1 and 40),
  constraint public_identities_handle_check check (handle ~ '^[a-z][a-z0-9_]{2,23}$'),
  constraint public_identities_bio_check check (bio is null or length(bio) <= 280)
);

create unique index public_identities_handle_lower_key on public.public_identities (lower(handle));
create index public_identities_avatar_media_id_idx on public.public_identities (avatar_media_id);
create index public_identities_home_city_area_id_idx on public.public_identities (home_city_area_id);
create index public_identities_profile_visibility_idx on public.public_identities (profile_visibility);

create trigger public_identities_touch_updated_at
  before update on public.public_identities
  for each row execute function earth.touch_updated_at();

create table public.auth_identities (
  id uuid primary key default gen_random_uuid(),
  human_id uuid not null references public.humans (id) on delete cascade,
  provider text not null,
  provider_subject text not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint auth_identities_provider_check check (
    provider in ('supabase', 'phone', 'email', 'apple', 'google', 'passkey')
  ),
  constraint auth_identities_provider_subject_check check (length(provider_subject) between 1 and 512),
  constraint auth_identities_provider_subject_key unique (provider, provider_subject)
);

create index auth_identities_human_id_idx on public.auth_identities (human_id);

create table public.human_passes (
  id uuid primary key default gen_random_uuid(),
  human_id uuid not null references public.humans (id) on delete cascade,
  provider text not null,
  provider_reference text,
  status public.human_pass_status not null default 'unverified',
  risk_level text,
  verified_at timestamptz,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint human_passes_provider_check check (provider in ('mock', 'manual_review', 'vendor')),
  constraint human_passes_risk_level_check check (risk_level is null or risk_level in ('low', 'medium', 'high')),
  -- One current pass per Human; results update it in place (spec §19 keeps `id` for provider references).
  constraint human_passes_human_id_key unique (human_id)
);

create trigger human_passes_touch_updated_at
  before update on public.human_passes
  for each row execute function earth.touch_updated_at();

-- spec §19 `metadata_private`: service only, reached through security definer RPCs.
create table private.human_pass_metadata (
  human_pass_id uuid primary key references public.human_passes (id) on delete cascade,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint human_pass_metadata_object_check check (jsonb_typeof(metadata) = 'object')
);

alter table private.human_pass_metadata enable row level security;
revoke all on table private.human_pass_metadata from public, anon, authenticated, service_role;

create table public.identity_reviews (
  id uuid primary key default gen_random_uuid(),
  human_id uuid not null references public.humans (id) on delete cascade,
  kind text not null,
  status text not null default 'open',
  details jsonb not null default '{}'::jsonb,
  duplicate_of_human_id uuid references public.humans (id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint identity_reviews_kind_check check (
    kind in ('duplicate', 'inconclusive', 'help', 'safety', 'recovery')
  ),
  constraint identity_reviews_status_check check (status in ('open', 'approved', 'rejected')),
  constraint identity_reviews_details_check check (jsonb_typeof(details) = 'object'),
  constraint identity_reviews_resolved_check check ((status = 'open') = (resolved_at is null))
);

create index identity_reviews_human_id_idx on public.identity_reviews (human_id);
create index identity_reviews_human_kind_status_idx on public.identity_reviews (human_id, kind, status);
create index identity_reviews_duplicate_of_human_id_idx on public.identity_reviews (duplicate_of_human_id);
create index identity_reviews_open_idx on public.identity_reviews (created_at) where status = 'open';

-- Earlier tables that point at Humans.
alter table public.media_objects
  add constraint media_objects_owner_human_id_fkey
  foreign key (owner_human_id) references public.humans (id) on delete set null;
alter table public.places
  add constraint places_created_by_human_id_fkey
  foreign key (created_by_human_id) references public.humans (id) on delete set null;

alter table public.humans enable row level security;
alter table public.public_identities enable row level security;
alter table public.auth_identities enable row level security;
alter table public.human_passes enable row level security;
alter table public.identity_reviews enable row level security;
