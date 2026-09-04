-- 0510 — production-safe base areas and places (spec §37–38, §76; DB_API §5, §10).
--
-- The minimal geography every environment needs so area_resolve / context resolution and public
-- Place tagging work out of the box: the United States, California and New York, the cities
-- San Francisco, Oakland, New York and Los Angeles, San Francisco's launch neighborhoods and three
-- public Places. Centroids are real; polygons are coarse, hand-drawn approximations (production
-- replaces them with real boundaries through the same idempotent helpers). Nothing here is a
-- fixture: `is_fixture` stays false. Development-only extras live in supabase/seed/areas.sql.
--
-- Both helpers are idempotent (keyed by slug / `provider_reference = 'earth:<key>'`) so re-running
-- a seed, or a later migration refining a boundary, updates in place. Owner and service only.
-- Slugs are hierarchical (`usa`, `usa-ca`, `usa-ca-san-francisco`, `usa-ca-san-francisco-mission`)
-- so they stay unique worldwide and never collide with ad-hoc slugs tests or tooling create.

-- Upserts an area by slug. `polygon_wkt` is a WKT POLYGON in lon/lat (SRID 4326) or null.
create or replace function earth.area_upsert(
  p_slug text,
  p_type public.area_type,
  p_name text,
  p_parent_slug text,
  p_lat double precision,
  p_lng double precision,
  p_polygon_wkt text,
  p_is_fixture boolean default false
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_parent uuid;
  v_id uuid;
  v_geometry extensions.geometry;
begin
  if p_parent_slug is not null then
    select a.id into v_parent from public.areas a where a.slug = p_parent_slug;
    if v_parent is null then
      perform earth.raise('area_not_found', format('parent area %s missing', p_parent_slug));
    end if;
  end if;
  if p_polygon_wkt is not null then
    v_geometry := extensions.st_multi(extensions.st_geomfromtext(p_polygon_wkt, 4326));
  end if;

  insert into public.areas as a (type, name, slug, parent_area_id, geometry, centroid, is_fixture)
  values (
    p_type, p_name, p_slug, v_parent,
    v_geometry,
    extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326),
    coalesce(p_is_fixture, false)
  )
  on conflict on constraint areas_slug_key do update
    set type = excluded.type,
        name = excluded.name,
        parent_area_id = excluded.parent_area_id,
        geometry = excluded.geometry,
        centroid = excluded.centroid,
        is_fixture = excluded.is_fixture,
        updated_at = now()
  returning a.id into v_id;
  return v_id;
end
$$;

-- Upserts a public Place keyed by `provider_reference = 'earth:<key>'` inside the area with the slug.
create or replace function earth.place_upsert(
  p_key text,
  p_name text,
  p_area_slug text,
  p_lat double precision,
  p_lng double precision,
  p_category text default null,
  p_is_fixture boolean default false
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_area uuid;
  v_id uuid;
begin
  select a.id into v_area from public.areas a where a.slug = p_area_slug;
  if v_area is null then
    perform earth.raise('area_not_found', format('area %s missing', p_area_slug));
  end if;

  insert into public.places as p (provider_reference, name, area_id, location, category, visibility, is_fixture)
  values (
    'earth:' || p_key, p_name, v_area,
    extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326),
    p_category, 'public', coalesce(p_is_fixture, false)
  )
  on conflict (provider_reference) where provider_reference is not null do update
    set name = excluded.name,
        area_id = excluded.area_id,
        location = excluded.location,
        category = excluded.category,
        is_fixture = excluded.is_fixture,
        updated_at = now()
  returning p.id into v_id;
  return v_id;
end
$$;

revoke execute on function earth.area_upsert(text, public.area_type, text, text, double precision, double precision, text, boolean)
  from public, anon, authenticated;
revoke execute on function earth.place_upsert(text, text, text, double precision, double precision, text, boolean)
  from public, anon, authenticated;

-- Country and regions -------------------------------------------------------------------------------
select earth.area_upsert('usa', 'country', 'United States', null, 39.8283, -98.5795,
  'POLYGON((-125.0 24.0, -66.0 24.0, -66.0 49.5, -125.0 49.5, -125.0 24.0))');

select earth.area_upsert('usa-ca', 'region', 'California', 'usa', 36.7783, -119.4179,
  'POLYGON((-124.45 42.0, -120.0 42.0, -120.0 39.0, -114.6 35.0, -114.5 32.7, -117.15 32.5, -120.6 34.4, -122.6 37.5, -124.45 40.4, -124.45 42.0))');

select earth.area_upsert('usa-ny', 'region', 'New York', 'usa', 42.9538, -75.5268,
  'POLYGON((-79.8 42.0, -79.8 43.3, -76.8 43.7, -76.2 44.2, -74.7 45.0, -73.3 45.0, -73.3 41.0, -71.8 41.3, -71.8 40.55, -74.3 40.45, -75.4 42.0, -79.8 42.0))');

-- Cities -------------------------------------------------------------------------------------------
select earth.area_upsert('usa-ca-san-francisco', 'city', 'San Francisco', 'usa-ca', 37.7749, -122.4194,
  'POLYGON((-122.52 37.70, -122.355 37.70, -122.355 37.835, -122.52 37.835, -122.52 37.70))');

select earth.area_upsert('usa-ca-oakland', 'city', 'Oakland', 'usa-ca', 37.8044, -122.2712,
  'POLYGON((-122.34 37.70, -122.11 37.70, -122.11 37.885, -122.34 37.885, -122.34 37.70))');

select earth.area_upsert('usa-ca-los-angeles', 'city', 'Los Angeles', 'usa-ca', 34.0522, -118.2437,
  'POLYGON((-118.67 33.70, -118.15 33.70, -118.15 34.34, -118.67 34.34, -118.67 33.70))');

select earth.area_upsert('usa-ny-new-york', 'city', 'New York', 'usa-ny', 40.7128, -74.0060,
  'POLYGON((-74.26 40.49, -73.70 40.49, -73.70 40.92, -74.26 40.92, -74.26 40.49))');

-- San Francisco neighborhoods (spec §37; coarse boxes that do not overlap each other) -----------------
select earth.area_upsert('usa-ca-san-francisco-north-beach', 'neighborhood', 'North Beach', 'usa-ca-san-francisco', 37.8025, -122.4100,
  'POLYGON((-122.418 37.797, -122.400 37.797, -122.400 37.808, -122.418 37.808, -122.418 37.797))');

select earth.area_upsert('usa-ca-san-francisco-mission', 'neighborhood', 'Mission', 'usa-ca-san-francisco', 37.7599, -122.4148,
  'POLYGON((-122.4285 37.748, -122.405 37.748, -122.405 37.770, -122.4285 37.770, -122.4285 37.748))');

select earth.area_upsert('usa-ca-san-francisco-dolores-heights', 'neighborhood', 'Dolores Heights', 'usa-ca-san-francisco', 37.7550, -122.4350,
  'POLYGON((-122.442 37.748, -122.4285 37.748, -122.4285 37.762, -122.442 37.762, -122.442 37.748))');

select earth.area_upsert('usa-ca-san-francisco-hayes-valley', 'neighborhood', 'Hayes Valley', 'usa-ca-san-francisco', 37.7759, -122.4245,
  'POLYGON((-122.432 37.772, -122.418 37.772, -122.418 37.780, -122.432 37.780, -122.432 37.772))');

select earth.area_upsert('usa-ca-san-francisco-soma', 'neighborhood', 'SoMa', 'usa-ca-san-francisco', 37.7785, -122.4056,
  'POLYGON((-122.418 37.770, -122.388 37.770, -122.388 37.790, -122.418 37.790, -122.418 37.770))');

select earth.area_upsert('usa-ca-san-francisco-marina', 'neighborhood', 'Marina', 'usa-ca-san-francisco', 37.8030, -122.4360,
  'POLYGON((-122.447 37.798, -122.425 37.798, -122.425 37.810, -122.447 37.810, -122.447 37.798))');

-- Public places (spec §76: a Place is never a device coordinate) --------------------------------------
select earth.place_upsert('dolores-park', 'Dolores Park', 'usa-ca-san-francisco-mission', 37.7596, -122.4270, 'park');
select earth.place_upsert('washington-square-park', 'Washington Square Park', 'usa-ca-san-francisco-north-beach', 37.8009, -122.4103, 'park');
select earth.place_upsert('ferry-building', 'Ferry Building', 'usa-ca-san-francisco', 37.7955, -122.3937, 'landmark');
