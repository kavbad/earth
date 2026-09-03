-- 0590 — Earth map objects (SCREEN 20; spec §52, §74, §76, §128 "Exact location is never inferred
-- as public permission"; DB_API §5 `map_objects`; ARCHITECTURE §4, §12).
--
-- `map_objects(scope, bbox)` assembles the four map layers for a scope and a bounding box and
-- never invents visibility of its own:
--   * lives    — `live_candidates(scope, area)` (the rooms tier decides discoverability) positioned
--                at the room's explicit public Place when it has one, else at the centroid of its
--                area per `area_precision` (neighborhood / city). Rooms with `area_precision = none`
--                and no Place have no position and are not on the map. A participant's device
--                location is never consulted (spec §76).
--   * places   — public Places inside the box (spec §38).
--   * friends  — `location_shares_visible()` (explicit, bounded shares that reach the caller, each
--                position already degraded by its precision), inside the box; Humans only.
--   * moments  — root posts tagged with a public Place, visible to the caller
--                (`earth.can_view_post`), in the scope's pool (mirrors `feed_candidates`).
-- Visitors (and claiming Humans, who read as anonymous viewers) get World only, while
-- PUBLIC_LIVE_ENABLED (lives) / PUBLIC_WORLD_ENABLED (moments) allow it; Guests have no discovery
-- surface (`guest_not_allowed`, as `live_candidates`). Neighborhood / City take the area from the
-- caller's `human_context`, falling back to the area containing the centre of the box the caller is
-- looking at (a browsing context, spec §52 — the same `area_id` argument `live_candidates` accepts).

-- ---------------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------------

-- Where a room sits on the map: its Place, else its area's centroid for neighborhood / city
-- precision; nulls when the room has no map position (`area_precision = none`, or a Place that no
-- longer exists). Never a participant's coordinates.
create or replace function earth.room_map_position(
  p_room public.rooms,
  out lat double precision,
  out lng double precision,
  out "precision" public.area_precision
)
language plpgsql
stable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_point extensions.geometry;
begin
  lat := null;
  lng := null;
  "precision" := null;
  if p_room.id is null then
    return;
  end if;
  if p_room.place_id is not null then
    select pl.location into v_point from public.places pl where pl.id = p_room.place_id;
    if v_point is not null then
      lat := extensions.st_y(v_point);
      lng := extensions.st_x(v_point);
      "precision" := 'place';
      return;
    end if;
  end if;
  if p_room.area_precision in ('neighborhood', 'city') and p_room.area_id is not null then
    select a.centroid into v_point from public.areas a where a.id = p_room.area_id;
    if v_point is not null then
      lat := extensions.st_y(v_point);
      lng := extensions.st_x(v_point);
      "precision" := p_room.area_precision;
    end if;
  end if;
end
$$;

-- Pin title of a Live from one `live_candidates` item: `Weekend Crew is live` for named group rooms,
-- else the publishers' names ordered for the viewer (spec §60) through `earth.live_title`
-- (`Xavier is live`, `Xavier + Kavon are live`), else the activity label, else `Live`.
create or replace function earth.map_live_title(p_item jsonb)
returns text
language plpgsql
stable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_context text := nullif(btrim(coalesce(p_item ->> 'contextTitle', '')), '');
  v_names text[];
  v_total integer := greatest(coalesce((p_item ->> 'participantCount')::integer, 0), 0);
  v_title text;
begin
  if p_item ->> 'contextType' = 'group' and v_context is not null then
    return v_context || ' is live';
  end if;
  select coalesce(array_agg(x.name order by x.rank, x.ord), '{}'::text[])
    into v_names
    from (
      select btrim(participant ->> 'displayName') as name,
             case participant ->> 'relationToViewer'
               when 'self' then 0
               when 'friend' then 1
               when 'shared_group' then 2
               when 'familiar' then 3
               else 4
             end as rank,
             t.ord
        from jsonb_array_elements(coalesce(p_item -> 'participants', '[]'::jsonb)) with ordinality as t(participant, ord)
    ) x
   where x.name is not null and x.name <> '';
  v_title := nullif(earth.live_title(v_names, greatest(v_total, coalesce(array_length(v_names, 1), 0))), '');
  return coalesce(v_title, nullif(btrim(coalesce(p_item ->> 'title', '')), ''), 'Live');
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- map_objects
-- ---------------------------------------------------------------------------------------------------

-- `MapObjectsDto` for a scope and a bounding box (`[min_lat, min_lng] .. [max_lat, max_lng]`).
create or replace function public.map_objects(
  scope public.audience,
  min_lat double precision,
  min_lng double precision,
  max_lat double precision,
  max_lng double precision
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_scope public.audience := scope;
  v_min_lat double precision := min_lat;
  v_min_lng double precision := min_lng;
  v_max_lat double precision := max_lat;
  v_max_lng double precision := max_lng;
  v_me uuid;
  v_ctx public.human_context%rowtype;
  v_area uuid;
  v_res record;
  v_production boolean := coalesce(earth.setting('environment'), '') = 'production';
  v_lives_enabled boolean;
  v_moments_enabled boolean;
  v_envelope extensions.geometry;
  v_live_items jsonb;
  v_lives jsonb := '[]'::jsonb;
  v_places jsonb := '[]'::jsonb;
  v_friends jsonb := '[]'::jsonb;
  v_moments jsonb := '[]'::jsonb;
begin
  if v_scope is null then
    perform earth.raise('invalid_input', 'scope is required');
  end if;
  if v_kind = 'guest' then
    perform earth.raise('guest_not_allowed');
  end if;
  if v_kind = 'human' then
    v_me := earth.current_human();
  end if;

  -- The box: both corners in range, south-west before north-east.
  perform earth.assert_lat_lng(v_min_lat, v_min_lng);
  perform earth.assert_lat_lng(v_max_lat, v_max_lng);
  if v_min_lat > v_max_lat or v_min_lng > v_max_lng then
    perform earth.raise('invalid_input', 'min_lat/min_lng must not exceed max_lat/max_lng');
  end if;
  v_envelope := extensions.st_makeenvelope(v_min_lng, v_min_lat, v_max_lng, v_max_lat, 4326);

  if v_me is null then
    if v_scope <> 'world' then
      perform earth.raise('not_authenticated');
    end if;
    v_lives_enabled := earth.flag('PUBLIC_LIVE_ENABLED');
    v_moments_enabled := earth.flag('PUBLIC_WORLD_ENABLED');
    if not v_lives_enabled and not v_moments_enabled then
      perform earth.raise('feature_disabled');
    end if;
  else
    if (v_scope = 'neighborhood' and not earth.flag('NEIGHBORHOOD_ENABLED'))
       or (v_scope = 'city' and not earth.flag('CITY_ENABLED'))
       or (v_scope = 'world' and not earth.flag('WORLD_ENABLED')) then
      perform earth.raise('feature_disabled');
    end if;
    v_lives_enabled := true;
    v_moments_enabled := true;
    select * into v_ctx from public.human_context hc where hc.human_id = v_me;
  end if;

  -- The browsing area for neighborhood / city (spec §52): the caller's context, else the area
  -- containing the centre of the box. Nothing about the box is stored.
  if v_scope in ('neighborhood', 'city') then
    v_res := earth.area_resolution((v_min_lat + v_max_lat) / 2, (v_min_lng + v_max_lng) / 2);
    if v_scope = 'neighborhood' then
      v_area := coalesce(v_ctx.current_area_id, v_res.neighborhood_id);
    else
      v_area := coalesce(
        v_ctx.current_city_id,
        earth.area_ancestor_of_type(v_ctx.current_area_id, 'city'),
        v_ctx.home_city_id,
        v_res.city_id
      );
    end if;
    if v_area is null or not exists (select 1 from public.areas a where a.id = v_area) then
      perform earth.raise('area_not_found');
    end if;
  end if;

  -- Lives: the rooms tier's discovery, positioned by Place or area centroid only.
  if v_lives_enabled then
    v_live_items := public.live_candidates(v_scope, v_area, 200) -> 'candidates';
    select coalesce(jsonb_agg(jsonb_build_object(
             'roomId', x.room_id,
             'title', x.title,
             'lat', x.lat,
             'lng', x.lng,
             'precision', x."precision",
             'participantCount', x.participant_count
           ) order by x.started_at desc, x.room_id), '[]'::jsonb)
      into v_lives
      from (
        select r.id as room_id,
               pos.lat,
               pos.lng,
               pos."precision",
               greatest(coalesce((item ->> 'participantCount')::integer, 0), 0) as participant_count,
               earth.map_live_title(item) as title,
               coalesce(r.started_at, r.created_at) as started_at
          from jsonb_array_elements(coalesce(v_live_items, '[]'::jsonb)) as item
          join public.rooms r on r.id = (item ->> 'roomId')::uuid
          join public.humans h on h.id = r.initiated_by_human_id
          cross join lateral earth.room_map_position(r) as pos
         where pos.lat is not null
           and not (v_production and h.is_fixture)
           and pos.lat between v_min_lat and v_max_lat
           and pos.lng between v_min_lng and v_max_lng
      ) x;
  end if;

  -- Places: public Places inside the box (spec §38, §76).
  select coalesce(jsonb_agg(earth.place_json(s.id) order by s.name, s.id), '[]'::jsonb)
    into v_places
    from (
      select pl.id, pl.name
        from public.places pl
       where pl.visibility = 'public'
         and not (v_production and pl.is_fixture)
         and pl.location operator(extensions.&&) v_envelope
         and extensions.st_intersects(pl.location, v_envelope)
       order by pl.name, pl.id
       limit 200
    ) s;

  -- Friends: explicit shares that reach the caller, already degraded by precision (0530).
  if v_me is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
             'humanId', s.share -> 'humanId',
             'displayName', s.share -> 'displayName',
             'avatarUrl', s.share -> 'avatarUrl',
             'lat', s.share -> 'lat',
             'lng', s.share -> 'lng',
             'precision', s.share -> 'precision',
             'expiresAt', s.share -> 'expiresAt'
           ) order by s.share ->> 'expiresAt' desc, s.share ->> 'shareId'), '[]'::jsonb)
      into v_friends
      from (
        select share
          from jsonb_array_elements(coalesce(public.location_shares_visible(), '[]'::jsonb)) as share
         where (share ->> 'lat')::double precision between v_min_lat and v_max_lat
           and (share ->> 'lng')::double precision between v_min_lng and v_max_lng
      ) s;
  end if;

  -- Moments: root posts tagged with a public Place, in the scope's pool (as feed_candidates: friends
  -- → self / friends / followed; neighborhood / city → the post's area, else its Place's area, inside
  -- the browsing area; world → world posts), visible to the caller and not hidden by them.
  if v_moments_enabled then
    select coalesce(jsonb_agg(jsonb_build_object(
             'postId', m.id,
             'lat', m.lat,
             'lng', m.lng,
             'authorDisplayName', m.author_name
           ) order by m.created_at desc, m.id), '[]'::jsonb)
      into v_moments
      from (
        select p.id, p.created_at, pl.lat, pl.lng,
               coalesce(pi.display_name, 'Earth member') as author_name
          from public.posts p
          join public.places pl on pl.id = p.place_id
          join public.humans h on h.id = p.author_human_id
          left join public.public_identities pi on pi.human_id = p.author_human_id
         where p.status = 'active'
           and p.parent_post_id is null
           and h.status = 'active'
           and not (v_production and h.is_fixture)
           and (pl.visibility = 'public' or (v_me is not null and pl.created_by_human_id = v_me))
           and pl.location operator(extensions.&&) v_envelope
           and extensions.st_intersects(pl.location, v_envelope)
           and case v_scope
                 when 'friends' then
                   v_me is not null and (
                     p.author_human_id = v_me
                     or earth.are_friends(v_me, p.author_human_id)
                     or earth.is_following(v_me, p.author_human_id)
                   )
                 when 'neighborhood' then
                   p.audience in ('neighborhood', 'city', 'world')
                   and earth.area_contains(v_area, coalesce(p.area_id, pl.area_id))
                 when 'city' then
                   p.audience in ('neighborhood', 'city', 'world')
                   and earth.area_contains(v_area, coalesce(p.area_id, pl.area_id))
                 else p.audience = 'world'
               end
           and earth.can_view_post(p.id, v_me)
           and not earth.post_hidden_by(p.id, v_me)
         order by p.created_at desc, p.id
         limit 200
      ) m;
  end if;

  return jsonb_build_object(
    'lives', v_lives,
    'places', v_places,
    'friends', v_friends,
    'moments', v_moments
  );
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------

revoke execute on function public.map_objects(public.audience, double precision, double precision, double precision, double precision) from public;
grant execute on function public.map_objects(public.audience, double precision, double precision, double precision, double precision) to anon, authenticated, service_role;

-- Internals stay reachable from RPCs only (schema `earth` has no USAGE for the API roles; the
-- default EXECUTE of 0002 is removed so nothing in this file is callable through a policy either).
revoke execute on function earth.room_map_position(public.rooms) from public, anon, authenticated;
revoke execute on function earth.map_live_title(jsonb) from public, anon, authenticated;
