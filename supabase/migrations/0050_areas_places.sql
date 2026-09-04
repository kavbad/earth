-- 0050 — areas and places (spec §37–38, DB_API ordering note / §5).
--
-- Created early because identity (`public_identities.home_city_area_id`), context (`human_context`)
-- and every audience rule reference areas. Area/location/map RPCs and the seeds live in 05xx.
-- Geometry columns use PostGIS from the `extensions` schema (0001); the migration session's
-- search_path resolves `geometry(...)` and the ST_* functions. World is implicit: no row.
-- Both tables are readable by everyone and written only through RPCs/seeds (place_create in 05xx).

create table public.areas (
  id uuid primary key default gen_random_uuid(),
  type public.area_type not null,
  name text not null,
  slug text not null,
  parent_area_id uuid references public.areas (id) on delete set null,
  geometry extensions.geometry(MultiPolygon, 4326),
  centroid extensions.geometry(Point, 4326) not null,
  bbox extensions.geometry(Polygon, 4326) generated always as (extensions.st_envelope(geometry)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint areas_name_check check (length(btrim(name)) between 1 and 120),
  constraint areas_slug_check check (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  constraint areas_slug_key unique (slug),
  constraint areas_no_self_parent check (parent_area_id is null or parent_area_id <> id)
);

create index areas_parent_area_id_idx on public.areas (parent_area_id);
create index areas_type_idx on public.areas (type);
create index areas_geometry_gix on public.areas using gist (geometry);
create index areas_centroid_gix on public.areas using gist (centroid);
create index areas_name_trgm_idx on public.areas using gin (name extensions.gin_trgm_ops);

create table public.places (
  id uuid primary key default gen_random_uuid(),
  provider_reference text,
  name text not null,
  area_id uuid not null references public.areas (id) on delete restrict,
  location extensions.geometry(Point, 4326) not null,
  lat double precision generated always as (extensions.st_y(location)) stored,
  lng double precision generated always as (extensions.st_x(location)) stored,
  category text,
  visibility text not null default 'public',
  -- FK to humans is added by 0120_identity.sql (humans does not exist yet).
  created_by_human_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint places_name_check check (length(btrim(name)) between 1 and 120),
  constraint places_visibility_check check (visibility in ('public', 'private')),
  constraint places_category_check check (category is null or length(category) between 1 and 60)
);

create index places_area_id_idx on public.places (area_id);
create index places_location_gix on public.places using gist (location);
create index places_visibility_idx on public.places (visibility);
create index places_created_by_human_id_idx on public.places (created_by_human_id);
create index places_name_trgm_idx on public.places using gin (name extensions.gin_trgm_ops);
create unique index places_provider_reference_key on public.places (provider_reference)
  where provider_reference is not null;

alter table public.areas enable row level security;
alter table public.places enable row level security;

grant select on table public.areas to anon, authenticated, service_role;
grant select on table public.places to anon, authenticated, service_role;

create policy areas_read_all on public.areas for select to anon, authenticated using (true);
create policy places_read_all on public.places for select to anon, authenticated using (true);

-- True when `child` is `parent` or lies inside it (walks the parent chain; cycles are bounded).
create or replace function earth.area_contains(parent uuid, child uuid)
returns boolean
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  with recursive chain as (
    select a.id, a.parent_area_id, 0 as depth
      from public.areas a
     where a.id = child
    union all
    select a.id, a.parent_area_id, chain.depth + 1
      from public.areas a
      join chain on a.id = chain.parent_area_id
     where chain.depth < 16
  )
  select parent is not null and child is not null
     and exists (select 1 from chain where chain.id = parent)
$$;

-- The nearest ancestor (or the area itself) of the given type, or null.
create or replace function earth.area_ancestor_of_type(area_id uuid, wanted public.area_type)
returns uuid
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  with recursive chain as (
    select a.id, a.parent_area_id, a.type, 0 as depth
      from public.areas a
     where a.id = area_ancestor_of_type.area_id
    union all
    select a.id, a.parent_area_id, a.type, chain.depth + 1
      from public.areas a
      join chain on a.id = chain.parent_area_id
     where chain.depth < 16
  )
  select chain.id from chain where chain.type = wanted order by chain.depth limit 1
$$;

-- `AreaDto` (`{ id, type, name, parentAreaId, centroid: { lat, lng } }`), or null when unknown.
create or replace function earth.area_json(area_id uuid)
returns jsonb
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
    'id', a.id,
    'type', a.type,
    'name', a.name,
    'parentAreaId', a.parent_area_id,
    'centroid', jsonb_build_object(
      'lat', extensions.st_y(a.centroid),
      'lng', extensions.st_x(a.centroid)
    )
  )
  from public.areas a
  where a.id = area_json.area_id
$$;

create or replace function earth.area_name(area_id uuid)
returns text
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select a.name from public.areas a where a.id = area_name.area_id
$$;
