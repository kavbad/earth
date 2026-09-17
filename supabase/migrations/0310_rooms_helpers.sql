-- 0310 — room helpers (DB_API §3 "Helper functions"; ARCHITECTURE §4, §10, §11; spec §57–§62, §87).
--
-- Everything the room RPCs (0330) and policies (0320) share: caller resolution for Guests,
-- visibility (`earth.room_visible_to` mirrors packages/domain/src/rooms/state.ts isRoomVisibleTo
-- plus blocks and area context), consent evaluation (widening is only ever applied by
-- `earth.room_evaluate_pending_visibility`), Live notifications with the dedupe rule of
-- packages/domain/src/notifications/dedupe.ts, room end, moderator transfer and the counters.
-- Read-only helpers are executable by the API roles (policies use them); mutating internals are
-- owner/service only.

-- ---------------------------------------------------------------------------------------------------
-- Caller resolution
-- ---------------------------------------------------------------------------------------------------

-- The caller's usable Guest session for a room (anonymous auth user, not removed, not expired).
create or replace function earth.current_guest_session_id(room_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select gs.id
    from public.guest_sessions gs
   where gs.room_id = current_guest_session_id.room_id
     and gs.auth_user_id = auth.uid()
     and auth.uid() is not null
     and earth.is_anonymous_jwt()
     and gs.removed_at is null
     and gs.expires_at > earth.utc_now()
   order by gs.created_at desc, gs.id
   limit 1
$$;

-- Active initiator/moderator participant (Guests never moderate).
create or replace function earth.room_is_moderator(room_id uuid, human_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select room_id is not null and human_id is not null and exists (
    select 1
      from public.room_participants rp
     where rp.room_id = room_is_moderator.room_id
       and rp.human_id = room_is_moderator.human_id
       and rp.status = 'active'
       and rp.role in ('initiator', 'moderator')
  )
$$;

-- The caller's live participant row (invited / waiting / active) in a room, Human or Guest; null row otherwise.
create or replace function earth.room_caller_participant(room_id uuid)
returns public.room_participants
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_row public.room_participants%rowtype;
begin
  if v_kind = 'guest' then
    select * into v_row
      from public.room_participants rp
     where rp.room_id = room_caller_participant.room_id
       and rp.guest_session_id = earth.current_guest_session_id(room_caller_participant.room_id)
       and rp.status in ('invited', 'waiting', 'active')
     order by rp.joined_at desc
     limit 1;
  elsif v_kind = 'human' then
    select * into v_row
      from public.room_participants rp
     where rp.room_id = room_caller_participant.room_id
       and rp.human_id = earth.current_human()
       and rp.status in ('invited', 'waiting', 'active')
     order by rp.joined_at desc
     limit 1;
  end if;
  return v_row;
end
$$;

-- The caller's active participant row (Human or Guest); null row when not active in the room.
create or replace function earth.room_active_participant(room_id uuid)
returns public.room_participants
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_row public.room_participants := earth.room_caller_participant(room_id);
  v_none public.room_participants%rowtype;
begin
  if v_row.id is null or v_row.status <> 'active' then
    return v_none;
  end if;
  return v_row;
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Visibility (spec §36, §58, §128 "Blocks override all discovery"; DB_API §3)
-- ---------------------------------------------------------------------------------------------------

-- Active Human participants publishing audio/camera whose consent covers the room's visibility.
create or replace function earth.room_publishing_humans(p_room_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select rp.human_id
    from public.room_participants rp
    join public.rooms r on r.id = rp.room_id
   where rp.room_id = p_room_id
     and rp.status = 'active'
     and rp.human_id is not null
     and rp.media_state <> 'watching'
     and rp.audience_consent_level >= r.visibility
$$;

-- Blocked either way with any consenting publishing participant → the room does not exist for the viewer.
create or replace function earth.room_blocked_for(p_room_id uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select p_viewer is not null and exists (
    select 1 from earth.room_publishing_humans(p_room_id) h where earth.is_blocked_either(p_viewer, h)
  )
$$;

-- Friend of any consenting publishing participant (spec §58 union of friendship graphs).
create or replace function earth.room_friend_of_publisher(p_room_id uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select p_viewer is not null and exists (
    select 1 from earth.room_publishing_humans(p_room_id) h where earth.are_friends(p_viewer, h)
  )
$$;

-- Friend of a friend of any consenting publishing participant (`extended` / `friends_of_friends`).
create or replace function earth.room_friend_of_friend_of_publisher(p_room_id uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select p_viewer is not null and exists (
    select 1
      from public.relationships r1
      join public.relationships r2
        on r2.source_human_id = r1.target_human_id and r2.type = 'friend'
     where r1.type = 'friend'
       and r1.source_human_id = p_viewer
       and r2.target_human_id <> p_viewer
       and r2.target_human_id in (select earth.room_publishing_humans(p_room_id))
  )
$$;

-- Area match for neighborhood / city Lives from the viewer's `human_context` (never coordinates),
-- plus the area the viewer is explicitly browsing (`live_candidates(area_id)`), if any.
create or replace function earth.room_area_matches(
  p_area_id uuid,
  p_visibility public.room_visibility,
  p_viewer uuid,
  p_viewer_area_id uuid default null
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_current_area uuid;
  v_current_city uuid;
  v_home_city uuid;
  v_room_city uuid;
begin
  if p_area_id is null or p_viewer is null then
    return false;
  end if;
  select hc.current_area_id, hc.current_city_id, hc.home_city_id
    into v_current_area, v_current_city, v_home_city
    from public.human_context hc
   where hc.human_id = p_viewer;
  if not found then
    return false;
  end if;
  -- The browsing radius the viewer selected counts as a current area (spec §52: a browsing context).
  if p_visibility = 'neighborhood' then
    return earth.area_contains(p_area_id, v_current_area)
        or earth.area_contains(p_area_id, v_current_city)
        or earth.area_contains(p_area_id, p_viewer_area_id);
  end if;
  if p_visibility = 'city' then
    v_room_city := coalesce(earth.area_ancestor_of_type(p_area_id, 'city'), p_area_id);
    return earth.area_contains(v_room_city, v_current_area)
        or earth.area_contains(v_room_city, v_current_city)
        or earth.area_contains(v_room_city, v_home_city)
        or earth.area_contains(v_room_city, p_viewer_area_id);
  end if;
  return false;
end
$$;

-- Whether `p_viewer` (an active Human id, or null for visitors/guests/claiming) may see a room.
-- Mirror of isRoomVisibleTo (packages/domain/src/rooms/state.ts) plus blocks, group membership,
-- the friend-graph union of spec §58, area context for neighborhood/city and the public World flag.
-- A live seat (invited / waiting / active) always sees its room: blocks override discovery (spec
-- §128) and the blocks trigger of 0360 clears the seat of a blocked pair, so a moderator who blocks
-- a participant never loses their own room. `viewer_area_id` is the area the viewer is browsing.
create or replace function earth.room_visible_to(room_id uuid, viewer_human_id uuid, viewer_area_id uuid default null)
returns boolean
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
begin
  if room_id is null then
    return false;
  end if;
  select * into v_room from public.rooms r where r.id = room_visible_to.room_id;
  if not found then
    return false;
  end if;

  if viewer_human_id is not null then
    if exists (
      select 1 from public.room_participants rp
       where rp.room_id = v_room.id and rp.human_id = viewer_human_id and rp.status in ('invited', 'waiting', 'active')
    ) then
      return true;
    end if;
    -- Removed participants are out for good.
    if exists (
      select 1 from public.room_participants rp
       where rp.room_id = v_room.id and rp.human_id = viewer_human_id and rp.status = 'removed'
    ) then
      return false;
    end if;
  end if;

  -- Blocks override all discovery (spec §128).
  if earth.room_blocked_for(v_room.id, viewer_human_id) then
    return false;
  end if;

  if viewer_human_id is not null then
    -- Former participants keep their ended or live room; group members see their group's room.
    if exists (
      select 1 from public.room_participants rp
       where rp.room_id = v_room.id and rp.human_id = viewer_human_id and rp.status = 'left'
    ) then
      return true;
    end if;
    if v_room.context_type = 'group' and earth.is_group_member(v_room.context_id, viewer_human_id) then
      return true;
    end if;
  end if;

  -- Beyond the room's own context only live rooms are discoverable.
  if v_room.status not in ('starting', 'active') then
    return false;
  end if;
  if v_room.visibility in ('invited', 'group') then
    return false;
  end if;
  if viewer_human_id is null then
    return v_room.visibility = 'world' and earth.flag('PUBLIC_LIVE_ENABLED');
  end if;

  if earth.room_friend_of_publisher(v_room.id, viewer_human_id) then
    return true;
  end if;
  if v_room.visibility = 'friends' then
    return false;
  end if;
  if earth.room_friend_of_friend_of_publisher(v_room.id, viewer_human_id) then
    return true;
  end if;
  if v_room.visibility = 'extended' then
    return false;
  end if;
  if v_room.visibility = 'world' then
    return true;
  end if;
  return earth.room_area_matches(v_room.area_id, v_room.visibility, viewer_human_id, viewer_area_id);
end
$$;

-- RLS entry point: the caller may read the room (service always; Guests only their own room).
create or replace function earth.room_readable_by_caller(room_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
begin
  if v_kind = 'service' then
    return true;
  end if;
  if v_kind = 'guest' then
    return earth.current_guest_session_id(room_id) is not null;
  end if;
  if v_kind = 'human' then
    return earth.room_visible_to(room_id, earth.current_human());
  end if;
  return earth.room_visible_to(room_id, null);
end
$$;

-- The caller is inside the room's context: a live participant, a Guest of the room, or a member of
-- the group it belongs to. Watching participants are visible only to these callers.
create or replace function earth.room_caller_in_room(room_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_me uuid;
  v_room public.rooms%rowtype;
begin
  if v_kind = 'service' then
    return true;
  end if;
  if v_kind = 'guest' then
    return earth.current_guest_session_id(room_id) is not null;
  end if;
  if v_kind <> 'human' then
    return false;
  end if;
  v_me := earth.current_human();
  if v_me is null then
    return false;
  end if;
  if exists (
    select 1 from public.room_participants rp
     where rp.room_id = room_caller_in_room.room_id and rp.human_id = v_me
       and rp.status in ('invited', 'waiting', 'active')
  ) then
    return true;
  end if;
  select * into v_room from public.rooms r where r.id = room_caller_in_room.room_id;
  return found and v_room.context_type = 'group' and earth.is_group_member(v_room.context_id, v_me);
end
$$;

-- RLS entry point for room_participants rows: own row always; live rows of a readable room when the
-- participant publishes or the caller is inside the room (viewers never reveal presence outward).
create or replace function earth.room_participant_readable(
  room_id uuid,
  human_id uuid,
  guest_session_id uuid,
  status public.participant_status,
  media_state public.media_state
)
returns boolean
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
begin
  if earth.current_role_kind() = 'service' then
    return true;
  end if;
  if (human_id is not null and human_id = earth.current_human_id())
     or (guest_session_id is not null and guest_session_id = earth.current_guest_session_id(room_id)) then
    return true;
  end if;
  if not earth.room_readable_by_caller(room_id) then
    return false;
  end if;
  if status not in ('invited', 'waiting', 'active') then
    return false;
  end if;
  if media_state <> 'watching' and status = 'active' then
    return true;
  end if;
  return earth.room_caller_in_room(room_id);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Naming mirrors (packages/domain/src/rooms/naming.ts: formatNameList with SPELLED_NAMES_MAX = 2)
-- ---------------------------------------------------------------------------------------------------

-- `Xavier` · `Xavier + Kavon` · `Xavier, Maya + 2` · `Maya + 2`.
create or replace function earth.live_name_list(p_names text[], p_total integer default null)
returns text
language plpgsql
immutable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_clean text[] := array(
    select btrim(n) from unnest(coalesce(p_names, '{}'::text[])) as n where btrim(coalesce(n, '')) <> ''
  );
  v_shown text[] := v_clean[1:2];
  v_shown_count integer := coalesce(array_length(v_shown, 1), 0);
  v_count integer := greatest(coalesce(p_total, coalesce(array_length(v_clean, 1), 0)), v_shown_count);
  v_rest integer := v_count - v_shown_count;
begin
  if v_shown_count = 0 then
    return case
             when v_rest > 0 then (case when v_rest = 1 then '1 person' else v_rest || ' people' end)
             else ''
           end;
  end if;
  if v_rest > 0 then
    return array_to_string(v_shown, ', ') || ' + ' || v_rest;
  end if;
  if v_shown_count = 1 then
    return v_shown[1];
  end if;
  return v_shown[1] || ' + ' || v_shown[2];
end
$$;

-- `Xavier is live` · `Xavier + Kavon are live` · `Xavier, Maya + 2 are live` ('' when nobody).
create or replace function earth.live_title(p_names text[], p_total integer default null)
returns text
language plpgsql
immutable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_subject text := earth.live_name_list(p_names, p_total);
  v_clean integer := (
    select count(*) from unnest(coalesce(p_names, '{}'::text[])) as n where btrim(coalesce(n, '')) <> ''
  );
  v_count integer := greatest(coalesce(p_total, coalesce(array_length(p_names, 1), 0)), v_clean);
begin
  if v_subject = '' then
    return '';
  end if;
  return v_subject || case when v_count = 1 then ' is live' else ' are live' end;
end
$$;

-- Ordering rank of a participant for a viewer (spec §60): friend < shared_group < familiar < other; guests last.
create or replace function earth.participant_relation_rank(p_viewer uuid, p_human_id uuid, p_is_guest boolean)
returns integer
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select case
           when p_is_guest then 4
           when p_viewer is null then 3
           else case earth.relation_to(p_viewer, p_human_id)
                  when 'self' then -1
                  when 'friend' then 0
                  when 'shared_group' then 1
                  when 'familiar' then 2
                  else 3
                end
         end
$$;

-- ---------------------------------------------------------------------------------------------------
-- JSON shapes (RoomParticipantDto, RoomDto, RoomVisibilityChangeDto)
-- ---------------------------------------------------------------------------------------------------

create or replace function earth.room_participant_json(p_participant_id uuid, p_viewer uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
    'id', rp.id,
    'humanId', rp.human_id,
    'guestSessionId', rp.guest_session_id,
    'displayName', coalesce(p.display_name, gs.display_name, rp.display_name_snapshot, 'Earth member'),
    'avatarUrl', earth.public_media_url(p.avatar_media_id),
    'isGuest', rp.guest_session_id is not null,
    'role', rp.role,
    'mediaState', rp.media_state,
    'status', rp.status,
    'audienceConsentLevel', rp.audience_consent_level,
    'joinedAt', to_jsonb(rp.joined_at),
    'relationToViewer', case
                          when p_viewer is null or rp.human_id is null then null
                          else earth.relation_to(p_viewer, rp.human_id)
                        end
  )
  from public.room_participants rp
  left join public.public_identities p on p.human_id = rp.human_id
  left join public.guest_sessions gs on gs.id = rp.guest_session_id
  where rp.id = p_participant_id
$$;

-- "Weekend Crew" for group rooms, the other members' names for direct rooms, null otherwise.
create or replace function earth.room_context_title(p_room_id uuid, p_viewer uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_names text[];
begin
  select * into v_room from public.rooms r where r.id = p_room_id;
  if not found then
    return null;
  end if;
  if v_room.context_type = 'group' then
    return (select g.name from public.groups g where g.id = v_room.context_id);
  end if;
  if v_room.context_type = 'direct' then
    select coalesce(array_agg(p.display_name order by cm.joined_at, cm.human_id), '{}'::text[])
      into v_names
      from public.conversation_members cm
      join public.public_identities p on p.human_id = cm.human_id
     where cm.conversation_id = v_room.context_id
       and cm.human_id is distinct from p_viewer;
    return nullif(earth.live_name_list(v_names), '');
  end if;
  return null;
end
$$;

-- `RoomDto` as seen by a Human viewer (`p_viewer`) or a Guest (`p_guest_session_id`), or a visitor.
create or replace function earth.room_json(p_room_id uuid, p_viewer uuid default null, p_guest_session_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_in_room boolean;
  v_participants jsonb;
  v_mine jsonb;
begin
  select * into v_room from public.rooms r where r.id = p_room_id;
  if not found then
    return null;
  end if;
  v_in_room := p_guest_session_id is not null
    or (p_viewer is not null and exists (
          select 1 from public.room_participants rp
           where rp.room_id = v_room.id and rp.human_id = p_viewer and rp.status in ('invited', 'waiting', 'active')))
    or (p_viewer is not null and v_room.context_type = 'group' and earth.is_group_member(v_room.context_id, p_viewer));

  select coalesce(jsonb_agg(earth.room_participant_json(rp.id, p_viewer) order by rp.joined_at, rp.id), '[]'::jsonb)
    into v_participants
    from public.room_participants rp
   where rp.room_id = v_room.id
     and rp.status in ('invited', 'waiting', 'active')
     and (v_in_room or (rp.status = 'active' and rp.media_state <> 'watching')
          or (p_viewer is not null and rp.human_id = p_viewer));

  select earth.room_participant_json(rp.id, p_viewer) into v_mine
    from public.room_participants rp
   where rp.room_id = v_room.id
     and ((p_viewer is not null and rp.human_id = p_viewer)
          or (p_guest_session_id is not null and rp.guest_session_id = p_guest_session_id))
     and rp.status in ('invited', 'waiting', 'active')
   order by rp.joined_at desc
   limit 1;

  return jsonb_build_object(
    'id', v_room.id,
    'contextType', v_room.context_type,
    'contextId', v_room.context_id,
    'initiatedByHumanId', v_room.initiated_by_human_id,
    'visibility', v_room.visibility,
    'joinPolicy', v_room.join_policy,
    'status', v_room.status,
    'areaPrecision', v_room.area_precision,
    'areaId', v_room.area_id,
    'placeId', v_room.place_id,
    'createdAt', to_jsonb(v_room.created_at),
    'startedAt', to_jsonb(v_room.started_at),
    'endedAt', to_jsonb(v_room.ended_at),
    'pendingVisibility', v_room.pending_visibility,
    'participants', v_participants,
    'myParticipant', v_mine,
    'contextTitle', earth.room_context_title(v_room.id, p_viewer),
    'guestsDisabled', v_room.guests_disabled,
    'title', v_room.title,
    'activeHumanCount', v_room.active_human_count,
    'activeParticipantCount', v_room.active_participant_count,
    'lastActivityAt', to_jsonb(v_room.last_activity_at)
  );
end
$$;

-- `RoomVisibilityChangeDto`.
create or replace function earth.room_visibility_change_json(
  p_applied boolean,
  p_visibility public.room_visibility,
  p_pending public.room_visibility,
  p_pending_ids uuid[]
)
returns jsonb
language sql
immutable
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
    'applied', p_applied,
    'visibility', p_visibility,
    'pendingVisibility', p_pending,
    'pendingParticipantIds', coalesce(to_jsonb(p_pending_ids), '[]'::jsonb)
  )
$$;

-- `ActiveRoomRefDto` now that rooms exist (replaces the dynamic 0160 version).
create or replace function earth.active_room_ref_json(room_id uuid)
returns jsonb
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object('roomId', r.id, 'participantCount', greatest(r.active_participant_count, 0))
    from public.rooms r
   where r.id = active_room_ref_json.room_id
     and r.status in ('starting', 'active')
$$;

-- ---------------------------------------------------------------------------------------------------
-- Join policies (mirror of allowedJoinPoliciesFor in packages/domain/src/audience.ts)
-- ---------------------------------------------------------------------------------------------------

create or replace function earth.allowed_join_policies(
  p_visibility public.room_visibility,
  p_context_type public.room_context_type default null
)
returns public.room_join_policy[]
language plpgsql
immutable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_policies public.room_join_policy[];
begin
  v_policies := case p_visibility
    when 'invited' then array['invited_only', 'request']::public.room_join_policy[]
    when 'group' then array['group', 'invited_only', 'request']::public.room_join_policy[]
    when 'friends' then array['friends', 'group', 'request', 'invited_only']::public.room_join_policy[]
    when 'extended' then array['friends_of_friends', 'friends', 'group', 'request', 'anyone_with_link', 'anyone', 'invited_only']::public.room_join_policy[]
    else array['request', 'anyone', 'anyone_with_link', 'friends_of_friends', 'friends', 'group', 'invited_only']::public.room_join_policy[]
  end;
  if p_context_type is not null and p_context_type <> 'group' then
    v_policies := array_remove(v_policies, 'group'::public.room_join_policy);
  end if;
  return v_policies;
end
$$;

-- Default visibility / join policy per context (defaultRoomVisibilityFor / defaultJoinPolicyFor).
create or replace function earth.default_room_visibility(p_context_type public.room_context_type)
returns public.room_visibility
language sql
immutable
set search_path = public, earth, private, pg_temp
as $$
  select case p_context_type
           when 'group' then 'group'::public.room_visibility
           when 'standalone' then 'friends'::public.room_visibility
           else 'invited'::public.room_visibility
         end
$$;

create or replace function earth.default_room_join_policy(p_context_type public.room_context_type)
returns public.room_join_policy
language sql
immutable
set search_path = public, earth, private, pg_temp
as $$
  select case p_context_type
           when 'group' then 'group'::public.room_join_policy
           when 'standalone' then 'friends'::public.room_join_policy
           else 'invited_only'::public.room_join_policy
         end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Room invites (mirror: packages/domain/src/invites/rules.ts isRoomInviteUsable — revoked > ended > expired)
-- ---------------------------------------------------------------------------------------------------

create or replace function earth.room_invite_usability(p_invite public.room_invites, p_room_status public.room_status)
returns text
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select case
           when p_invite.revoked_at is not null or p_invite.status = 'revoked' then 'revoked'
           when p_room_status = 'ended' then 'ended'
           when p_invite.status = 'expired' or p_invite.expires_at <= earth.utc_now() then 'expired'
           else 'ok'
         end
$$;

-- The invite for a token hash, or raises `invite_invalid` / `room_ended` / `invite_expired`.
create or replace function earth.assert_room_invite_usable(p_token_hash text)
returns public.room_invites
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_invite public.room_invites%rowtype;
  v_status public.room_status;
  v_usability text;
begin
  if p_token_hash is null then
    perform earth.raise('invite_invalid');
  end if;
  select * into v_invite from public.room_invites ri where ri.token_hash = p_token_hash;
  if not found then
    perform earth.raise('invite_invalid');
  end if;
  select r.status into v_status from public.rooms r where r.id = v_invite.room_id;
  v_usability := earth.room_invite_usability(v_invite, v_status);
  if v_usability = 'revoked' then
    perform earth.raise('invite_invalid');
  elsif v_usability = 'ended' then
    perform earth.raise('room_ended');
  elsif v_usability = 'expired' then
    perform earth.raise('invite_expired');
  end if;
  return v_invite;
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Counters (rooms.active_human_count / active_participant_count / humans_absent_since)
-- ---------------------------------------------------------------------------------------------------

create or replace function earth.room_participants_count_trigger()
returns trigger
language plpgsql
set search_path = public, earth, private, pg_temp
as $$
declare
  v_room_id uuid := coalesce(new.room_id, old.room_id);
  v_participants integer;
  v_humans integer;
begin
  select count(*), count(*) filter (where rp.human_id is not null)
    into v_participants, v_humans
    from public.room_participants rp
   where rp.room_id = v_room_id and rp.status = 'active';

  update public.rooms r
     set active_participant_count = v_participants,
         active_human_count = v_humans,
         humans_absent_since = case when v_humans = 0 then coalesce(r.humans_absent_since, earth.utc_now()) else null end,
         last_activity_at = earth.utc_now()
   where r.id = v_room_id;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;

create trigger room_participants_count
  after insert or update of status, human_id, guest_session_id or delete on public.room_participants
  for each row execute function earth.room_participants_count_trigger();

-- ---------------------------------------------------------------------------------------------------
-- Live notifications (spec §57 step 8, §58 step 7, §86–§87; ARCHITECTURE §11)
-- ---------------------------------------------------------------------------------------------------

-- Notifies the eligible recipients of a room event: group members (per conversation preferences)
-- for group rooms, and for `friends` or wider the union of the friends of every consenting active
-- Human publisher — never active participants, never across a block. `p_joining_human_id` is the
-- Human whose audio/camera join triggered the call (null for room-level events: start, open up).
-- Dedupe per recipient × room mirrors shouldNotifyLive exactly. Returns the number of rows created.
create or replace function earth.notify_live(p_room_id uuid, p_joining_human_id uuid default null)
returns integer
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_now timestamptz := earth.utc_now();
  v_cooldown interval := make_interval(mins => coalesce(nullif(earth.setting('live_notification_cooldown_minutes'), '')::integer, 30));
  v_joining_media public.media_state;
  v_publishers uuid[];
  v_group_name text;
  v_conversation_id uuid;
  v_actor uuid;
  v_recipient uuid;
  v_cd public.notification_cooldowns%rowtype;
  v_window_open boolean;
  v_send boolean;
  v_next_sends integer;
  v_names text[];
  v_total integer;
  v_type text;
  v_title text;
  v_payload jsonb;
  v_id uuid;
  v_sent integer := 0;
begin
  select * into v_room from public.rooms r where r.id = p_room_id;
  if not found or v_room.status not in ('starting', 'active') then
    return 0;
  end if;

  if p_joining_human_id is not null then
    select rp.media_state into v_joining_media
      from public.room_participants rp
     where rp.room_id = v_room.id and rp.human_id = p_joining_human_id and rp.status = 'active'
     order by rp.joined_at desc
     limit 1;
    -- Rule 4: viewers are invisible; nothing to announce.
    if v_joining_media is null or v_joining_media = 'watching' then
      return 0;
    end if;
  end if;

  v_publishers := array(select earth.room_publishing_humans(v_room.id));
  -- Nobody publishing (Humans or Guests) → nothing to announce (liveNotificationCopy returns null).
  if not exists (
    select 1 from public.room_participants rp
     where rp.room_id = v_room.id and rp.status = 'active' and rp.media_state <> 'watching'
  ) then
    return 0;
  end if;

  v_actor := coalesce(p_joining_human_id, v_room.initiated_by_human_id);
  if v_room.context_type = 'group' then
    select g.name into v_group_name from public.groups g where g.id = v_room.context_id;
    select c.id into v_conversation_id from public.conversations c where c.group_id = v_room.context_id;
  end if;

  for v_recipient in
    with members as (
      select gm.human_id
        from public.group_members gm
       where v_room.context_type = 'group'
         and gm.group_id = v_room.context_id
         and gm.status = 'active'
         and coalesce((select cm.notification_level from public.conversation_members cm
                        where cm.conversation_id = v_conversation_id and cm.human_id = gm.human_id), 'all') = 'all'
         and coalesce((select cm.mute_state from public.conversation_members cm
                        where cm.conversation_id = v_conversation_id and cm.human_id = gm.human_id), 'none') = 'none'
    ),
    friends as (
      select r.target_human_id as human_id
        from public.relationships r
       where v_room.visibility >= 'friends'
         and r.type = 'friend'
         and r.source_human_id = any (v_publishers)
    ),
    candidates as (
      select human_id from members
      union
      select human_id from friends
    )
    select c.human_id
      from candidates c
      join public.humans h on h.id = c.human_id and h.status = 'active'
     where c.human_id <> v_actor
       and not exists (
         select 1 from public.room_participants rp
          where rp.room_id = v_room.id and rp.human_id = c.human_id and rp.status = 'active'
       )
       and not earth.room_blocked_for(v_room.id, c.human_id)
     order by c.human_id
  loop
    select * into v_cd
      from public.notification_cooldowns nc
     where nc.recipient_human_id = v_recipient and nc.room_id = v_room.id
       for update;

    v_window_open := found and (v_now - v_cd.last_sent_at) < v_cooldown;
    v_send := false;
    if not v_window_open then
      -- Rules 1 and 5: no window → send and open one.
      v_send := true;
      v_next_sends := 1;
    elsif p_joining_human_id is null then
      null; -- cooldown: room-level churn
    elsif not earth.are_friends(v_recipient, p_joining_human_id) then
      null; -- not_direct_friend
    elsif v_joining_media <> 'camera' then
      null; -- not_on_camera
    elsif p_joining_human_id = any (v_cd.notified_participant_ids) then
      null; -- already_notified
    elsif v_cd.sends_in_window >= 2 then
      null; -- extra_send_used
    else
      -- Rule 2: the one extra send.
      v_send := true;
      v_next_sends := v_cd.sends_in_window + 1;
    end if;

    if not v_send then
      continue;
    end if;

    -- Names ordered for this recipient (spec §60), publishers only, recipient excluded.
    select coalesce(array_agg(x.name order by x.rank, x.media_rank, x.joined_at, x.id), '{}'::text[]), count(*)
      into v_names, v_total
      from (
        select coalesce(p.display_name, gs.display_name, rp.display_name_snapshot, 'Earth member') as name,
               earth.participant_relation_rank(v_recipient, rp.human_id, rp.guest_session_id is not null) as rank,
               case rp.media_state when 'camera' then 0 when 'audio' then 1 else 2 end as media_rank,
               rp.joined_at, rp.id
          from public.room_participants rp
          left join public.public_identities p on p.human_id = rp.human_id
          left join public.guest_sessions gs on gs.id = rp.guest_session_id
         where rp.room_id = v_room.id
           and rp.status = 'active'
           and rp.media_state <> 'watching'
           and rp.human_id is distinct from v_recipient
      ) x;
    if v_total = 0 then
      continue;
    end if;

    if v_room.context_type = 'group' and nullif(btrim(coalesce(v_group_name, '')), '') is not null then
      v_type := 'group_live';
      v_title := v_group_name || ' is live';
      v_payload := jsonb_build_object('groupName', v_group_name, 'names', to_jsonb(v_names), 'total', v_total);
    elsif v_total = 1 then
      v_type := 'friend_live';
      v_title := earth.live_title(v_names, v_total);
      v_payload := jsonb_build_object('name', v_names[1], 'activity', v_room.title);
    else
      v_type := 'multi_live';
      v_title := earth.live_title(v_names, v_total);
      v_payload := jsonb_build_object('names', to_jsonb(v_names), 'total', v_total);
    end if;
    v_payload := v_payload || jsonb_build_object(
      'roomId', v_room.id,
      'participantNames', to_jsonb(v_names),
      'participantCount', v_total,
      'contextTitle', case when v_room.context_type = 'group' then v_group_name else null end,
      'title', v_title
    );

    v_id := earth.notify(v_recipient, v_type, v_actor, 'room', v_room.id, v_payload, 'critical_social');
    if v_id is null then
      continue;
    end if;
    v_sent := v_sent + 1;

    insert into public.notification_cooldowns as nc (recipient_human_id, room_id, last_sent_at, sends_in_window, notified_participant_ids)
    values (
      v_recipient, v_room.id, v_now, v_next_sends,
      (select coalesce(array_agg(distinct h), '{}'::uuid[])
         from unnest(v_publishers || coalesce(p_joining_human_id, v_actor)) as h)
    )
    on conflict on constraint notification_cooldowns_pkey do update
      set last_sent_at = excluded.last_sent_at,
          sends_in_window = excluded.sends_in_window,
          notified_participant_ids = (
            select coalesce(array_agg(distinct h), '{}'::uuid[])
              from unnest(nc.notified_participant_ids || excluded.notified_participant_ids) as h
          );
  end loop;

  return v_sent;
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Consent evaluation (ARCHITECTURE §10 "Widening is only ever applied by this evaluation")
-- ---------------------------------------------------------------------------------------------------

-- Participant ids of active Human publishers whose consent is below `p_level`.
create or replace function earth.room_pending_participant_ids(p_room_id uuid, p_level public.room_visibility)
returns uuid[]
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select coalesce(array_agg(rp.id order by rp.joined_at, rp.id), '{}'::uuid[])
    from public.room_participants rp
   where rp.room_id = p_room_id
     and rp.status = 'active'
     and rp.human_id is not null
     and rp.media_state <> 'watching'
     and rp.audience_consent_level < p_level
$$;

-- Applies `pending_visibility` (with its join policy and area) once every active audio/camera Human
-- consents to it, then notifies the newly eligible audience. Returns `RoomVisibilityChangeDto`.
create or replace function earth.room_evaluate_pending_visibility(p_room_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_pending uuid[];
begin
  select * into v_room from public.rooms r where r.id = p_room_id for update;
  if not found then
    perform earth.raise('room_not_found');
  end if;
  if v_room.pending_visibility is null or v_room.status not in ('starting', 'active') then
    return earth.room_visibility_change_json(false, v_room.visibility, v_room.pending_visibility, '{}'::uuid[]);
  end if;

  v_pending := earth.room_pending_participant_ids(v_room.id, v_room.pending_visibility);
  if cardinality(v_pending) > 0 then
    return earth.room_visibility_change_json(false, v_room.visibility, v_room.pending_visibility, v_pending);
  end if;

  update public.rooms r
     set visibility = r.pending_visibility,
         join_policy = coalesce(r.pending_join_policy, r.join_policy),
         area_precision = coalesce(r.pending_area_precision, r.area_precision),
         area_id = coalesce(r.pending_area_id, r.area_id),
         pending_visibility = null,
         pending_join_policy = null,
         pending_area_precision = null,
         pending_area_id = null,
         last_activity_at = earth.utc_now()
   where r.id = v_room.id
  returning * into v_room;

  perform earth.notify_live(v_room.id, null);
  return earth.room_visibility_change_json(true, v_room.visibility, null, '{}'::uuid[]);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Moderator transfer (spec §61) and room end (spec §62)
-- ---------------------------------------------------------------------------------------------------

-- After a moderator left: when no active moderator remains, hands the room to the earliest active
-- verified Human participant (never a Guest). Returns the new moderator, or null.
create or replace function earth.room_transfer_moderator(p_room_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_new uuid;
begin
  if exists (
    select 1 from public.room_participants rp
     where rp.room_id = p_room_id and rp.status = 'active' and rp.human_id is not null
       and rp.role in ('initiator', 'moderator')
  ) then
    return null;
  end if;
  select rp.human_id into v_new
    from public.room_participants rp
    join public.humans h on h.id = rp.human_id and h.status = 'active'
   where rp.room_id = p_room_id and rp.status = 'active' and rp.human_id is not null
   order by (h.human_pass_status = 'verified') desc, rp.joined_at, rp.id
   limit 1;
  if v_new is null then
    return null;
  end if;
  update public.room_participants rp
     set role = 'moderator'
   where rp.room_id = p_room_id and rp.human_id = v_new and rp.status = 'active';
  return v_new;
end
$$;

-- Ends a room: status, pointers, participants, guest sessions (expire after the guest grace), presence.
-- Returns false when the room was already ended.
create or replace function earth.room_end_internal(p_room_id uuid, p_reason text default null)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_now timestamptz := earth.utc_now();
  v_guest_grace integer := coalesce(nullif(earth.setting('guest_session_grace_seconds'), '')::integer, 600);
  v_reason text := left(coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'ended'), 60);
  v_updated integer;
begin
  update public.rooms r
     set status = 'ended',
         ended_at = v_now,
         ended_reason = v_reason,
         pending_visibility = null,
         pending_join_policy = null,
         pending_area_precision = null,
         pending_area_id = null,
         last_activity_at = v_now
   where r.id = p_room_id and r.status <> 'ended';
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return false;
  end if;

  update public.groups g set active_room_id = null where g.active_room_id = p_room_id;
  update public.conversations c set active_room_id = null where c.active_room_id = p_room_id;
  update public.human_presence hp set active_room_id = null where hp.active_room_id = p_room_id;

  update public.room_participants rp
     set status = 'left', left_at = v_now
   where rp.room_id = p_room_id and rp.status in ('invited', 'waiting', 'active');

  update public.guest_sessions gs
     set expires_at = least(gs.expires_at, v_now + make_interval(secs => v_guest_grace))
   where gs.room_id = p_room_id and gs.removed_at is null;

  perform earth.audit('room_end', 'room', p_room_id, jsonb_build_object('reason', v_reason));
  return true;
end
$$;

-- Mutating internals and secrets stay owner/service only.
revoke execute on function earth.notify_live(uuid, uuid) from public, anon, authenticated;
revoke execute on function earth.room_evaluate_pending_visibility(uuid) from public, anon, authenticated;
revoke execute on function earth.room_transfer_moderator(uuid) from public, anon, authenticated;
revoke execute on function earth.room_end_internal(uuid, text) from public, anon, authenticated;
revoke execute on function earth.assert_room_invite_usable(text) from public, anon, authenticated;
