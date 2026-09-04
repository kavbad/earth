-- 0530 — area, place, location-sharing and context RPCs (spec §37–39, §52, §74–76, §83;
-- DB_API §5; ARCHITECTURE §4, §5, §12).
--
-- Principles (spec §74 / §128 "Exact location is never inferred as public permission"):
--   * area_resolve / context_resolve_and_set convert a device position into area ids and store
--     nothing but those ids (human_context has no coordinate column);
--   * a location share is explicit, bounded (≤ 24 h) and addressed to one audience; its position is
--     degraded by the share's precision when written and again when read; blocks hide it either way;
--   * Places are public objects, never a device coordinate (spec §76).
-- Every RPC is security definer with the fixed search_path, validates the caller through
-- earth.current_role_kind() / earth.assert_human(), rate-limits with earth.rate_limit_for_caller
-- and raises only earth.raise('<code>') codes. PostGIS lives in `extensions` and is schema-qualified.

-- ---------------------------------------------------------------------------------------------------
-- Geometry helpers
-- ---------------------------------------------------------------------------------------------------

-- Raises `invalid_input` unless both coordinates are present and within range.
create or replace function earth.assert_lat_lng(p_lat double precision, p_lng double precision)
returns void
language plpgsql
stable
set search_path = public, earth, private, pg_temp
as $$
begin
  if p_lat is null or p_lng is null
     or p_lat <> p_lat or p_lng <> p_lng
     or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    perform earth.raise('invalid_input', 'lat must be within [-90, 90] and lng within [-180, 180]');
  end if;
end
$$;

create or replace function earth.geo_point(p_lat double precision, p_lng double precision)
returns extensions.geometry
language sql
immutable
strict
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)
$$;

-- Snaps a coordinate to a grid of `p_step` degrees (0.01 ≈ 1 km, 0.1 ≈ 11 km). Half-way values
-- round away from zero (numeric rounding), the same rule the tests reproduce.
create or replace function earth.geo_snap(p_value double precision, p_step numeric)
returns double precision
language sql
immutable
strict
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select (round(p_value::numeric / p_step) * p_step)::double precision
$$;

-- The smallest area of `p_type` whose polygon contains the point, or null.
create or replace function earth.area_containing(p_point extensions.geometry, p_type public.area_type)
returns uuid
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select a.id
    from public.areas a
   where a.type = p_type
     and a.geometry is not null
     and extensions.st_contains(a.geometry, p_point)
   order by extensions.st_area(a.geometry), a.id
   limit 1
$$;

-- Neighborhood and city containing a position (ST_Contains on the smallest matching areas). The
-- city falls back to the neighborhood's city ancestor. Pure: stores nothing.
create or replace function earth.area_resolution(
  p_lat double precision,
  p_lng double precision,
  out neighborhood_id uuid,
  out city_id uuid
)
language plpgsql
stable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_point extensions.geometry := earth.geo_point(p_lat, p_lng);
begin
  neighborhood_id := earth.area_containing(v_point, 'neighborhood');
  city_id := earth.area_containing(v_point, 'city');
  if city_id is null and neighborhood_id is not null then
    city_id := earth.area_ancestor_of_type(neighborhood_id, 'city');
  end if;
end
$$;

-- Escapes a user query for use inside an ILIKE pattern (`escape '\'`).
create or replace function earth.like_escape(p_text text)
returns text
language sql
immutable
strict
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select replace(replace(replace(p_text, '\', '\\'), '%', '\%'), '_', '\_')
$$;

-- `PlaceDto` (spec §38), or null when unknown.
create or replace function earth.place_json(p_place_id uuid)
returns jsonb
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
    'id', pl.id,
    'name', pl.name,
    'areaId', pl.area_id,
    'areaName', earth.area_name(pl.area_id),
    'lat', pl.lat,
    'lng', pl.lng,
    'category', pl.category,
    'visibility', pl.visibility
  )
    from public.places pl
   where pl.id = p_place_id
$$;

-- A search query trimmed and bounded (spec §83 search limits apply per RPC).
create or replace function earth.search_query(p_q text)
returns text
language plpgsql
stable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_q text := nullif(btrim(coalesce(p_q, '')), '');
begin
  if v_q is null or length(v_q) > 100 then
    perform earth.raise('invalid_input', 'q must be 1 to 100 characters');
  end if;
  return v_q;
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Location share helpers
-- ---------------------------------------------------------------------------------------------------

-- `LocationShareDto` (spec §39).
create or replace function earth.location_share_json(p_share public.location_shares)
returns jsonb
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
    'id', p_share.id,
    'humanId', p_share.human_id,
    'audienceType', p_share.audience_type,
    'audienceId', p_share.audience_id,
    'precision', p_share.precision,
    'expiresAt', to_jsonb(p_share.expires_at),
    'createdAt', to_jsonb(p_share.created_at),
    'revokedAt', to_jsonb(p_share.revoked_at)
  )
$$;

-- Validates that `p_me` may address this audience: a friend (active, not blocked, friendship
-- required), a group (active membership) or a temporary context (an active Room the sharer is in).
create or replace function earth.location_share_assert_audience(
  p_me uuid,
  p_type public.location_audience_type,
  p_audience uuid
)
returns void
language plpgsql
stable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_room_status public.room_status;
begin
  if p_type is null or p_audience is null then
    perform earth.raise('invalid_input', 'audience_type and audience_id are required');
  end if;
  if p_type = 'friend' then
    if p_audience = p_me then
      perform earth.raise('invalid_input', 'audience_id must be another Human');
    end if;
    perform earth.assert_active_human(p_audience);
    if earth.is_blocked_either(p_me, p_audience) then
      perform earth.raise('blocked');
    end if;
    if not earth.are_friends(p_me, p_audience) then
      perform earth.raise('forbidden', 'location can only be shared with a friend');
    end if;
  elsif p_type = 'group' then
    if not exists (select 1 from public.groups g where g.id = p_audience and g.status = 'active') then
      perform earth.raise('group_not_found');
    end if;
    if not earth.is_group_member(p_audience, p_me) then
      perform earth.raise('not_a_member');
    end if;
  else
    select r.status into v_room_status from public.rooms r where r.id = p_audience;
    if v_room_status is null then
      perform earth.raise('room_not_found');
    end if;
    if v_room_status = 'ended' then
      perform earth.raise('room_ended');
    end if;
    if not exists (
      select 1 from public.room_participants rp
       where rp.room_id = p_audience and rp.human_id = p_me and rp.status = 'active'
    ) then
      perform earth.raise('not_in_room');
    end if;
  end if;
end
$$;

-- Whether `p_share` currently reaches `p_viewer` through its audience (friendship, membership or
-- room participation must still hold). Blocks and expiry are checked by the caller.
create or replace function earth.location_share_reaches(p_share public.location_shares, p_viewer uuid)
returns boolean
language plpgsql
stable
set search_path = public, earth, private, pg_temp
as $$
begin
  if p_viewer is null or p_share.human_id = p_viewer then
    return false;
  end if;
  if p_share.audience_type = 'friend' then
    return p_share.audience_id = p_viewer and earth.are_friends(p_share.human_id, p_viewer);
  elsif p_share.audience_type = 'group' then
    return exists (select 1 from public.groups g where g.id = p_share.audience_id and g.status = 'active')
       and earth.is_group_member(p_share.audience_id, p_viewer)
       and earth.is_group_member(p_share.audience_id, p_share.human_id);
  else
    return exists (
      select 1
        from public.rooms r
        join public.room_participants me on me.room_id = r.id and me.human_id = p_viewer and me.status = 'active'
        join public.room_participants owner on owner.room_id = r.id and owner.human_id = p_share.human_id and owner.status = 'active'
       where r.id = p_share.audience_id
         and r.status in ('starting', 'active')
    );
  end if;
end
$$;

-- A position as a recipient may see it: `city` → the resolved city's centroid (else a 0.1° cell),
-- `approximate` → a 0.01° cell, `precise` → as stored.
create or replace function earth.location_degraded(
  p_precision public.location_precision,
  p_location extensions.geometry,
  p_city_area_id uuid,
  out lat double precision,
  out lng double precision
)
language plpgsql
stable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_centroid extensions.geometry;
begin
  if p_precision = 'precise' then
    lat := extensions.st_y(p_location);
    lng := extensions.st_x(p_location);
  elsif p_precision = 'approximate' then
    lat := earth.geo_snap(extensions.st_y(p_location), 0.01);
    lng := earth.geo_snap(extensions.st_x(p_location), 0.01);
  else
    select a.centroid into v_centroid from public.areas a where a.id = p_city_area_id;
    if v_centroid is not null then
      lat := extensions.st_y(v_centroid);
      lng := extensions.st_x(v_centroid);
    else
      lat := earth.geo_snap(extensions.st_y(p_location), 0.1);
      lng := earth.geo_snap(extensions.st_x(p_location), 0.1);
    end if;
  end if;
end
$$;

-- Writes the latest position of a share with the share's precision already applied: a `city`
-- share stores its city (centroid), an `approximate` share a grid cell, only `precise` the point.
create or replace function earth.location_share_write_position(
  p_share_id uuid,
  p_precision public.location_precision,
  p_lat double precision,
  p_lng double precision
)
returns void
language plpgsql
volatile
set search_path = public, earth, private, pg_temp
as $$
declare
  v_city uuid := (earth.area_resolution(p_lat, p_lng)).city_id;
  v_stored extensions.geometry;
  v_degraded record;
begin
  if p_precision = 'precise' then
    v_stored := earth.geo_point(p_lat, p_lng);
  else
    v_degraded := earth.location_degraded(p_precision, earth.geo_point(p_lat, p_lng), v_city);
    v_stored := earth.geo_point(v_degraded.lat, v_degraded.lng);
  end if;

  insert into public.location_share_positions as lp (share_id, location, city_area_id, updated_at)
  values (p_share_id, v_stored, v_city, earth.utc_now())
  on conflict (share_id) do update
    set location = excluded.location,
        city_area_id = excluded.city_area_id,
        updated_at = excluded.updated_at;
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Areas
-- ---------------------------------------------------------------------------------------------------

-- {neighborhood: AreaDto|null, city: AreaDto|null} for a position; the position is never stored.
create or replace function public.area_resolve(lat double precision, lng double precision)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_lat double precision := lat;
  v_lng double precision := lng;
  v_res record;
begin
  if v_kind = 'visitor' then
    perform earth.raise('not_authenticated');
  end if;
  perform earth.assert_lat_lng(v_lat, v_lng);
  perform earth.rate_limit_for_caller('area_resolve', 240, 3600);
  v_res := earth.area_resolution(v_lat, v_lng);
  return jsonb_build_object(
    'neighborhood', earth.area_json(v_res.neighborhood_id),
    'city', earth.area_json(v_res.city_id)
  );
end
$$;

-- AreaDto[] matching a query by name (trigram similarity + substring), best first, at most 20.
create or replace function public.areas_search(q text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_q text := earth.search_query(q);
  v_pattern text;
begin
  perform earth.rate_limit_for_caller('areas_search', 60, 60);
  v_pattern := '%' || earth.like_escape(v_q) || '%';
  return coalesce((
    select jsonb_agg(earth.area_json(s.id) order by s.exact desc, s.prefix desc, s.sim desc, s.name, s.id)
      from (
        select a.id, a.name,
               lower(a.name) = lower(v_q) as exact,
               a.name ilike earth.like_escape(v_q) || '%' escape '\' as prefix,
               extensions.similarity(a.name, v_q) as sim
          from public.areas a
         where a.name ilike v_pattern escape '\'
            or extensions.similarity(a.name, v_q) >= 0.3
         order by (lower(a.name) = lower(v_q)) desc,
                  (a.name ilike earth.like_escape(v_q) || '%' escape '\') desc,
                  extensions.similarity(a.name, v_q) desc, a.name, a.id
         limit 20
      ) s
  ), '[]'::jsonb);
end
$$;

create or replace function public.area_get(id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_json jsonb := earth.area_json(id);
begin
  if v_json is null then
    perform earth.raise('area_not_found');
  end if;
  return v_json;
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Places
-- ---------------------------------------------------------------------------------------------------

-- PlaceDto[] by name, optionally inside an area (its neighborhoods included). Public places, plus
-- the caller's own private ones. At most 20.
create or replace function public.places_search(q text, area_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_q text := earth.search_query(q);
  v_area uuid := area_id;
  v_me uuid := earth.current_human();
  v_pattern text;
begin
  if v_area is not null and not exists (select 1 from public.areas a where a.id = v_area) then
    perform earth.raise('area_not_found');
  end if;
  perform earth.rate_limit_for_caller('places_search', 60, 60);
  v_pattern := '%' || earth.like_escape(v_q) || '%';
  return coalesce((
    select jsonb_agg(earth.place_json(s.id) order by s.exact desc, s.prefix desc, s.sim desc, s.name, s.id)
      from (
        select p.id, p.name,
               lower(p.name) = lower(v_q) as exact,
               p.name ilike earth.like_escape(v_q) || '%' escape '\' as prefix,
               extensions.similarity(p.name, v_q) as sim
          from public.places p
         where (p.name ilike v_pattern escape '\' or extensions.similarity(p.name, v_q) >= 0.3)
           and (p.visibility = 'public' or (v_me is not null and p.created_by_human_id = v_me))
           and (v_area is null or earth.area_contains(v_area, p.area_id))
         order by (lower(p.name) = lower(v_q)) desc,
                  (p.name ilike earth.like_escape(v_q) || '%' escape '\') desc,
                  extensions.similarity(p.name, v_q) desc, p.name, p.id
         limit 20
      ) s
  ), '[]'::jsonb);
end
$$;

create or replace function public.place_get(id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.current_human();
  v_place public.places%rowtype;
begin
  select * into v_place from public.places p where p.id = place_get.id;
  if v_place.id is null
     or (v_place.visibility <> 'public' and (v_me is null or v_place.created_by_human_id is distinct from v_me)) then
    perform earth.raise('not_visible');
  end if;
  return earth.place_json(v_place.id);
end
$$;

-- Creates a public Place (spec §76) at a position; the area is resolved from the position when not
-- given (neighborhood, else city). A public place with the same name in the same area is reused.
create or replace function public.place_create(
  name text,
  lat double precision,
  lng double precision,
  area_id uuid default null,
  category text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_name text := nullif(btrim(coalesce(name, '')), '');
  v_category text := nullif(btrim(coalesce(category, '')), '');
  v_lat double precision := lat;
  v_lng double precision := lng;
  v_area uuid := area_id;
  v_res record;
  v_id uuid;
begin
  if v_name is null or length(v_name) > 120 then
    perform earth.raise('invalid_input', 'name must be 1 to 120 characters');
  end if;
  if v_category is not null and length(v_category) > 60 then
    perform earth.raise('invalid_input', 'category must be at most 60 characters');
  end if;
  perform earth.assert_lat_lng(v_lat, v_lng);
  perform earth.rate_limit_for_caller('place_create', 20, 3600);

  if v_area is null then
    v_res := earth.area_resolution(v_lat, v_lng);
    v_area := coalesce(v_res.neighborhood_id, v_res.city_id);
    if v_area is null then
      perform earth.raise('area_not_found', 'no known area contains this position');
    end if;
  elsif not exists (select 1 from public.areas a where a.id = v_area) then
    perform earth.raise('area_not_found');
  end if;

  select p.id into v_id
    from public.places p
   where p.area_id = v_area
     and p.visibility = 'public'
     and lower(p.name) = lower(v_name)
   order by p.created_at, p.id
   limit 1;
  if v_id is not null then
    return earth.place_json(v_id);
  end if;

  insert into public.places (name, area_id, location, category, visibility, created_by_human_id)
  values (v_name, v_area, earth.geo_point(v_lat, v_lng), v_category, 'public', v_me)
  returning id into v_id;
  return earth.place_json(v_id);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Location sharing (spec §39, §75)
-- ---------------------------------------------------------------------------------------------------

-- Starts a bounded share with one audience and stores the initial position (degraded by precision).
-- A previous live share to the same audience is replaced. Returns LocationShareDto.
create or replace function public.location_share_create(
  audience_type public.location_audience_type,
  audience_id uuid,
  "precision" public.location_precision,
  duration_seconds integer,
  lat double precision,
  lng double precision
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_type public.location_audience_type := audience_type;
  v_audience uuid := audience_id;
  v_precision public.location_precision := "precision";
  v_duration integer := duration_seconds;
  v_lat double precision := lat;
  v_lng double precision := lng;
  v_now timestamptz := earth.utc_now();
  v_share public.location_shares%rowtype;
begin
  if not earth.flag('LOCATION_SHARING_ENABLED') then
    perform earth.raise('location_sharing_disabled');
  end if;
  if v_type is null or v_audience is null or v_precision is null then
    perform earth.raise('invalid_input', 'audience_type, audience_id and precision are required');
  end if;
  if v_duration is null or v_duration <= 0 or v_duration > 24 * 3600 then
    perform earth.raise('invalid_input', 'duration_seconds must be between 1 and 86400 (24 hours)');
  end if;
  perform earth.assert_lat_lng(v_lat, v_lng);
  perform earth.rate_limit_for_caller('location_share_create', 30, 3600);
  perform earth.location_share_assert_audience(v_me, v_type, v_audience);

  update public.location_shares ls
     set revoked_at = v_now
   where ls.human_id = v_me
     and ls.audience_type = v_type
     and ls.audience_id = v_audience
     and ls.revoked_at is null;

  insert into public.location_shares (human_id, audience_type, audience_id, precision, expires_at, created_at)
  values (v_me, v_type, v_audience, v_precision, v_now + make_interval(secs => v_duration), v_now)
  returning * into v_share;

  perform earth.location_share_write_position(v_share.id, v_precision, v_lat, v_lng);
  perform earth.audit(
    'location_share_create', 'location_share', v_share.id,
    jsonb_build_object('audienceType', v_type, 'audienceId', v_audience, 'precision', v_precision)
  );
  return earth.location_share_json(v_share);
end
$$;

-- Replaces the latest position of the caller's live share. Returns LocationShareDto.
create or replace function public.location_share_update(share_id uuid, lat double precision, lng double precision)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_lat double precision := lat;
  v_lng double precision := lng;
  v_share public.location_shares%rowtype;
begin
  perform earth.assert_lat_lng(v_lat, v_lng);
  perform earth.rate_limit_for_caller('location_share_update', 720, 3600);
  select * into v_share from public.location_shares ls where ls.id = share_id and ls.human_id = v_me;
  if v_share.id is null then
    perform earth.raise('not_visible');
  end if;
  if v_share.revoked_at is not null or v_share.expires_at <= earth.utc_now() then
    perform earth.raise('invalid_input', 'the share is no longer live');
  end if;
  perform earth.location_share_write_position(v_share.id, v_share.precision, v_lat, v_lng);
  return earth.location_share_json(v_share);
end
$$;

-- Ends the caller's share now (idempotent); its position is deleted by the 0500 trigger.
create or replace function public.location_share_revoke(share_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_share public.location_shares%rowtype;
begin
  perform earth.rate_limit_for_caller('location_share_revoke', 120, 3600);
  select * into v_share from public.location_shares ls where ls.id = share_id and ls.human_id = v_me;
  if v_share.id is null then
    perform earth.raise('not_visible');
  end if;
  if v_share.revoked_at is null then
    update public.location_shares ls
       set revoked_at = earth.utc_now()
     where ls.id = v_share.id
    returning * into v_share;
    perform earth.audit('location_share_revoke', 'location_share', v_share.id);
  end if;
  return earth.location_share_json(v_share);
end
$$;

-- Shares that currently reach the caller, as MapFriendDto[] (plus shareId / audience fields), with
-- every position degraded by its share's precision. Excludes expired and revoked shares, blocked
-- pairs (either direction), inactive sharers and the caller's own shares.
create or replace function public.location_shares_visible()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_now timestamptz := earth.utc_now();
begin
  return coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'shareId', ls.id,
               'humanId', ls.human_id,
               'displayName', coalesce(pi.display_name, 'Someone'),
               'avatarUrl', earth.public_media_url(pi.avatar_media_id),
               'lat', d.lat,
               'lng', d.lng,
               'precision', ls.precision,
               'audienceType', ls.audience_type,
               'audienceId', ls.audience_id,
               'expiresAt', to_jsonb(ls.expires_at),
               'updatedAt', to_jsonb(lp.updated_at)
             )
             order by ls.expires_at desc, ls.id
           )
      from public.location_shares ls
      join public.location_share_positions lp on lp.share_id = ls.id
      join public.humans h on h.id = ls.human_id and h.status = 'active'
      left join public.public_identities pi on pi.human_id = ls.human_id
      cross join lateral earth.location_degraded(ls.precision, lp.location, lp.city_area_id) d
     where ls.revoked_at is null
       and ls.expires_at > v_now
       and ls.human_id <> v_me
       and not earth.is_blocked_either(ls.human_id, v_me)
       and earth.location_share_reaches(ls, v_me)
  ), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Context (spec §52, §74)
-- ---------------------------------------------------------------------------------------------------

-- Resolves a position and stores only the resulting area ids in human_context: the current
-- neighborhood (null when outside every known one) and the current city (unchanged when the
-- position is outside every known city). Returns HumanContextDto. Coordinates are never stored.
create or replace function public.context_resolve_and_set(lat double precision, lng double precision)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_lat double precision := lat;
  v_lng double precision := lng;
  v_res record;
begin
  perform earth.assert_lat_lng(v_lat, v_lng);
  perform earth.rate_limit_for_caller('context_resolve', 240, 3600);
  v_res := earth.area_resolution(v_lat, v_lng);

  insert into public.human_context (human_id, current_area_id, current_city_id)
  values (v_me, v_res.neighborhood_id, v_res.city_id)
  on conflict on constraint human_context_pkey do update
    set current_area_id = case
          when excluded.current_city_id is null then public.human_context.current_area_id
          else excluded.current_area_id
        end,
        current_city_id = coalesce(excluded.current_city_id, public.human_context.current_city_id);

  return earth.human_context_json(v_me);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Grants (ARCHITECTURE §5: nothing executable by PUBLIC; API roles per RPC)
-- ---------------------------------------------------------------------------------------------------

revoke execute on function public.area_resolve(double precision, double precision) from public;
revoke execute on function public.areas_search(text) from public;
revoke execute on function public.area_get(uuid) from public;
revoke execute on function public.places_search(text, uuid) from public;
revoke execute on function public.place_get(uuid) from public;
revoke execute on function public.place_create(text, double precision, double precision, uuid, text) from public;
revoke execute on function public.location_share_create(public.location_audience_type, uuid, public.location_precision, integer, double precision, double precision) from public;
revoke execute on function public.location_share_update(uuid, double precision, double precision) from public;
revoke execute on function public.location_share_revoke(uuid) from public;
revoke execute on function public.location_shares_visible() from public;
revoke execute on function public.context_resolve_and_set(double precision, double precision) from public;

grant execute on function public.area_resolve(double precision, double precision) to anon, authenticated, service_role;
grant execute on function public.areas_search(text) to anon, authenticated, service_role;
grant execute on function public.area_get(uuid) to anon, authenticated, service_role;
grant execute on function public.places_search(text, uuid) to anon, authenticated, service_role;
grant execute on function public.place_get(uuid) to anon, authenticated, service_role;
grant execute on function public.place_create(text, double precision, double precision, uuid, text) to anon, authenticated, service_role;
grant execute on function public.location_share_create(public.location_audience_type, uuid, public.location_precision, integer, double precision, double precision) to anon, authenticated, service_role;
grant execute on function public.location_share_update(uuid, double precision, double precision) to anon, authenticated, service_role;
grant execute on function public.location_share_revoke(uuid) to anon, authenticated, service_role;
grant execute on function public.location_shares_visible() to anon, authenticated, service_role;
grant execute on function public.context_resolve_and_set(double precision, double precision) to anon, authenticated, service_role;

-- Internal helpers that write or reveal state stay owner/service only.
revoke execute on function earth.location_share_write_position(uuid, public.location_precision, double precision, double precision) from public, anon, authenticated;
revoke execute on function earth.location_share_assert_audience(uuid, public.location_audience_type, uuid) from public, anon, authenticated;
revoke execute on function earth.location_share_reaches(public.location_shares, uuid) from public, anon, authenticated;
revoke execute on function earth.location_degraded(public.location_precision, extensions.geometry, uuid) from public, anon, authenticated;
revoke execute on function earth.area_resolution(double precision, double precision) from public, anon, authenticated;
revoke execute on function earth.area_containing(extensions.geometry, public.area_type) from public, anon, authenticated;
