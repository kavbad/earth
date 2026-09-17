-- 0006 — feature flags and app settings (ARCHITECTURE §12, DB_API ordering note / §8).
--
-- Both tables are readable by every caller (visitors included: the client resolves flags before it
-- knows who it is) and written only by the service role. `earth.flag(key)` and `earth.setting(key)`
-- are the SQL entry points RPCs and policies use; a missing flag is disabled, a missing setting null.
-- Keys are exactly the spec §118 list, mirrored by `FEATURE_FLAG_KEYS` in packages/config.

create table public.feature_flags (
  key text primary key,
  enabled boolean not null default false,
  payload jsonb,
  updated_at timestamptz not null default now(),
  constraint feature_flags_key_check check (key ~ '^[A-Z][A-Z0-9_]*$'),
  constraint feature_flags_payload_check check (payload is null or jsonb_typeof(payload) = 'object')
);

create table public.app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  constraint app_settings_key_check check (key ~ '^[a-z][a-z0-9_]*$')
);

alter table public.feature_flags enable row level security;
alter table public.app_settings enable row level security;

grant select on table public.feature_flags to anon, authenticated, service_role;
grant select on table public.app_settings to anon, authenticated, service_role;

create policy feature_flags_read_all on public.feature_flags
  for select to anon, authenticated using (true);
create policy app_settings_read_all on public.app_settings
  for select to anon, authenticated using (true);

-- True only when the flag row exists and is enabled.
create or replace function earth.flag(key text)
returns boolean
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select coalesce((select f.enabled from public.feature_flags f where f.key = flag.key), false)
$$;

-- The setting's value, or null when absent.
create or replace function earth.setting(key text)
returns text
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select s.value from public.app_settings s where s.key = setting.key
$$;

-- Every flag as `FlagsDto` (`{ KEY: { enabled, payload, updatedAt } }`), for `me_get()`.
create or replace function earth.flags_json()
returns jsonb
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select coalesce(
    jsonb_object_agg(
      f.key,
      jsonb_build_object('enabled', f.enabled, 'payload', f.payload, 'updatedAt', to_jsonb(f.updated_at))
    ),
    '{}'::jsonb
  )
  from public.feature_flags f
$$;

-- Launch defaults (ARCHITECTURE §12, spec §118).
insert into public.feature_flags (key, enabled) values
  ('GROUP_ANCHORED_CLAIM_REQUIRED', true),
  ('PUBLIC_WORLD_ENABLED', true),
  ('PUBLIC_LIVE_ENABLED', true),
  ('NEIGHBORHOOD_ENABLED', true),
  ('CITY_ENABLED', true),
  ('WORLD_ENABLED', true),
  ('GUEST_ROOMS_ENABLED', true),
  ('FRIENDS_LIVE_EXPANSION_ENABLED', true),
  ('WORLD_LIVE_EXPANSION_ENABLED', true),
  ('LOCATION_SHARING_ENABLED', true),
  ('MAFIA_ACTIVITY_ENABLED', false);

-- Settings the database reads at runtime (ARCHITECTURE §10/§14, DB_API §1/§8/§10).
insert into public.app_settings (key, value) values
  ('public_storage_base_url', ''),
  ('room_grace_seconds', '120'),
  ('web_origin', 'https://earth.social'),
  ('environment', 'development');
