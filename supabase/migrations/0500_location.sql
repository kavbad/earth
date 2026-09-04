-- 0500 — location sharing tables (spec §39, §74–75; DB_API §5; ARCHITECTURE §5, §12).
--
-- A location share is always explicit, always bounded (at most 24 hours from creation, spec §75
-- "No forever default") and always addressed to one audience: a friend (`audience_id` = that
-- Human), a group (`audience_id` = the group; membership required) or a temporary context
-- (`audience_id` = an active Room the sharer is in). Recipients never read the tables: they call
-- `location_shares_visible()` (0530), which degrades every position by the share's precision and
-- applies blocks. The sharer reads their own rows (0520).
--
-- `location_share_positions` keeps the latest position only, never a history (spec §74 "Do not
-- continuously store exact user location for social history"). Precision is applied when the row is
-- written as well as when it is read: an `approximate` share never stores more than a 0.01° grid
-- cell, a `city` share stores the resolved city (its centroid is what recipients see) and a coarse
-- 0.1° fallback point. The row is deleted the moment its share is revoked — by the owner, by a
-- block (earth.revoke_location_shares_between, 0180) or by rooms_sweep() expiry (0330) — through
-- the trigger below.
--
-- `areas.is_fixture` / `places.is_fixture` mark development-only rows (supabase/seed/areas.sql);
-- the production-safe base rows of 0510 keep the default `false`.

alter table public.areas add column is_fixture boolean not null default false;
alter table public.places add column is_fixture boolean not null default false;

create table public.location_shares (
  id uuid primary key default gen_random_uuid(),
  human_id uuid not null references public.humans (id) on delete cascade,
  audience_type public.location_audience_type not null,
  audience_id uuid not null,
  precision public.location_precision not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  constraint location_shares_expires_after_created check (expires_at > created_at),
  constraint location_shares_max_duration check (expires_at <= created_at + interval '24 hours'),
  constraint location_shares_revoked_check check (revoked_at is null or revoked_at >= created_at)
);

create index location_shares_human_id_idx on public.location_shares (human_id);
create index location_shares_audience_idx on public.location_shares (audience_type, audience_id);
create index location_shares_expires_at_idx on public.location_shares (expires_at) where revoked_at is null;
-- One live share per audience: location_share_create revokes the previous one before inserting.
create unique index location_shares_live_audience_key
  on public.location_shares (human_id, audience_type, audience_id)
  where revoked_at is null;

create table public.location_share_positions (
  share_id uuid primary key references public.location_shares (id) on delete cascade,
  location extensions.geometry(Point, 4326) not null,
  -- The city the position resolved to when written (null outside every known city); what a
  -- `city` share shows. Never a device coordinate.
  city_area_id uuid references public.areas (id) on delete set null,
  updated_at timestamptz not null default now()
);

create index location_share_positions_location_gix on public.location_share_positions using gist (location);
create index location_share_positions_city_area_id_idx on public.location_share_positions (city_area_id);

alter table public.location_shares enable row level security;
alter table public.location_share_positions enable row level security;

-- A revoked share keeps no position, whoever revoked it (owner, block, sweep).
create or replace function earth.location_share_revoked_trigger()
returns trigger
language plpgsql
set search_path = public, earth, private, pg_temp
as $$
begin
  if new.revoked_at is not null and old.revoked_at is null then
    delete from public.location_share_positions p where p.share_id = new.id;
  end if;
  return new;
end
$$;

revoke execute on function earth.location_share_revoked_trigger() from public, anon, authenticated;

create trigger location_shares_revoked
  after update of revoked_at on public.location_shares
  for each row execute function earth.location_share_revoked_trigger();

create trigger location_share_positions_touch_updated_at
  before update on public.location_share_positions
  for each row execute function earth.touch_updated_at();
