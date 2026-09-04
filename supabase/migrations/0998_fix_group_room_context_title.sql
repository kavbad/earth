-- 0998 — fix (audience): Live discovery names a group room by its participants, never by the
-- private group's name, for viewers who are not in that group (spec §60 participant-aware naming,
-- SCREEN 13 "Cards show participant-aware naming", §116 E2E 5; §128 private group content;
-- DB_API §3 `live_candidates`). Reproduced by e2e/journeys/05-friend-live.spec.ts.
--
-- 0961 closed the same leak for direct rooms and left group rooms naming their group to every
-- viewer. But the moment a group room opens up (spec §58 `Open up -> Friends`), it is discovered
-- by the friends of its camera participants — Humans who are not in that group. `live_candidates`
-- feeds all three discovery surfaces (Live Home, the Home feed's live payload through
-- `feed_candidates`, and the map pins through `map_objects`), so a stranger's Live card read
-- "Weekend Crew is live" and carried `contextTitle: "Weekend Crew"`: the name of a private group
-- they are not in, instead of the friend they actually know.
--
-- Discovery now passes a group room's context title to the group's active members only; everyone
-- else gets `null` and the naming layer falls back to the publishers, viewer-first ("Bo + Ada are
-- live" — `liveCardTitle`, `earth.map_live_title`, `earth.live_title`), exactly as 0961 made
-- direct rooms behave. Members are unchanged: their card still says "Weekend Crew is live", and so
-- does their `group_live` notification (`earth.notify_live` reads `public.groups` directly).
--
-- Only discovery changes. `earth.room_context_title` itself is untouched, so `room_get` (SCREEN 14
-- header, for people who are in the room) and `room_invite_preview` (SCREEN 17 "Show: … room
-- context", for whoever holds the link a member shared) still name the group. The signature and
-- the grants of `live_candidates` are those of 0330.

-- The context title a viewer may be shown *before* they are in the room: a group's name is its
-- members' (spec §128); direct rooms already answer their members only (0961).
create or replace function earth.room_discovery_context_title(p_room_id uuid, p_viewer uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
begin
  select * into v_room from public.rooms r where r.id = p_room_id;
  if not found then
    return null;
  end if;
  if v_room.context_type = 'group' and not earth.is_group_member(v_room.context_id, p_viewer) then
    return null;
  end if;
  return earth.room_context_title(p_room_id, p_viewer);
end
$$;

-- 0330 `live_candidates` verbatim, with the one changed line marked below.
create or replace function public.live_candidates(scope public.audience, area_id uuid default null, "limit" integer default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_scope public.audience := scope;
  v_area uuid := area_id;
  v_limit integer := least(greatest(coalesce("limit", 50), 1), 200);
  v_me uuid;
  v_ctx public.human_context%rowtype;
  v_items jsonb;
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
  if v_me is null then
    if v_scope <> 'world' then
      perform earth.raise('not_authenticated');
    end if;
    if not earth.flag('PUBLIC_LIVE_ENABLED') then
      perform earth.raise('feature_disabled');
    end if;
  end if;
  if (v_scope = 'neighborhood' and not earth.flag('NEIGHBORHOOD_ENABLED'))
     or (v_scope = 'city' and not earth.flag('CITY_ENABLED'))
     or (v_scope = 'world' and v_me is not null and not earth.flag('WORLD_ENABLED')) then
    perform earth.raise('feature_disabled');
  end if;

  if v_me is not null then
    select * into v_ctx from public.human_context hc where hc.human_id = v_me;
  end if;
  if v_scope = 'neighborhood' then
    v_area := coalesce(v_area, v_ctx.current_area_id);
  elsif v_scope = 'city' then
    v_area := coalesce(v_area, v_ctx.current_city_id, earth.area_ancestor_of_type(v_ctx.current_area_id, 'city'), v_ctx.home_city_id);
  else
    v_area := null;
  end if;
  if v_scope in ('neighborhood', 'city') and v_area is null then
    perform earth.raise('area_not_found');
  end if;

  with candidates as (
    select r.*
      from public.rooms r
     where r.status in ('starting', 'active')
       and r.active_participant_count > 0
       and case v_scope
             when 'friends' then
               v_me is not null and (
                 exists (select 1 from public.room_participants rp
                          where rp.room_id = r.id and rp.human_id = v_me and rp.status in ('invited', 'waiting', 'active'))
                 or (r.context_type = 'group' and earth.is_group_member(r.context_id, v_me))
                 or (r.visibility >= 'friends' and earth.room_friend_of_publisher(r.id, v_me))
                 or (r.visibility >= 'extended' and earth.room_friend_of_friend_of_publisher(r.id, v_me))
               )
             when 'neighborhood' then r.visibility >= 'neighborhood' and earth.area_contains(v_area, r.area_id)
             when 'city' then r.visibility >= 'neighborhood' and earth.area_contains(v_area, r.area_id)
             else r.visibility = 'world'
           end
       and earth.room_visible_to(r.id, v_me, v_area)
     order by r.started_at desc nulls last, r.id
     limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'roomId', c.id,
           'contextType', c.context_type,
           'contextId', c.context_id,
           'visibility', c.visibility,
           'joinPolicy', c.join_policy,
           'title', c.title,
           -- 0998: the group's name is its members'; everyone else is named by participants.
           'contextTitle', earth.room_discovery_context_title(c.id, v_me),
           'areaId', c.area_id,
           'areaName', earth.area_name(c.area_id),
           'areaPrecision', c.area_precision,
           'startedAt', to_jsonb(coalesce(c.started_at, c.created_at)),
           'participantCount', (select count(*) from public.room_participants rp
                                 where rp.room_id = c.id and rp.status = 'active' and rp.media_state <> 'watching'),
           'participants', (select coalesce(jsonb_agg(earth.room_participant_json(rp.id, v_me) order by rp.joined_at, rp.id), '[]'::jsonb)
                              from public.room_participants rp
                             where rp.room_id = c.id and rp.status = 'active' and rp.media_state <> 'watching')
         ) order by c.started_at desc nulls last, c.id), '[]'::jsonb)
    into v_items
    from candidates c;

  return jsonb_build_object(
    'candidates', v_items,
    'scope', v_scope,
    'areaId', v_area,
    'areaName', earth.area_name(v_area)
  );
end
$$;
