-- 1000 — fix (audience): a participant seat is not group membership. `earth.room_json` must not
-- name a private group to a viewer who merely holds a seat in its opened-up Room (spec §128
-- "Private group/chat content never appears in World", §60 participant-aware naming, SCREEN 14;
-- DB_API §3 `room_get`). Reproduced by e2e/journeys/05-friend-live.spec.ts:242.
--
-- 0999 gated `contextTitle` on `v_in_room` — a seat in `invited`/`waiting`/`active`, a Guest
-- session of this room, or active membership of the room's group. That closed the leak for a
-- viewer who only *reads* the room, but both room screens open a Live as a viewer first
-- (spec §59): `apps/web/components/rooms/RoomScreen.tsx:175` and
-- `apps/mobile/components/rooms/RoomScreen.tsx` call `room_join(media_state => 'watching')` on
-- mount. One `room_get` later the outsider had a seat, `v_in_room` was true, and the header of
-- SCREEN 14 read "Weekend Crew" — the name of a private group `public.groups` refuses to show
-- them (0170 RLS) and that 0998/0999 removed from every other surface. E2E 5 walks exactly that:
-- C taps a friend's Live card, lands in the room as a viewer, and read the group's name.
--
-- The predicate for the *title* is membership, not presence: `earth.room_discovery_context_title`
-- (0998) already answers a group's name to its active members only and delegates every other
-- context to `earth.room_context_title` (so direct rooms keep 0961's members-only answer and
-- standalone rooms are unchanged). Guests are deliberately excluded from the change: a member
-- shared them the link and `room_invite_preview` names the group on SCREEN 17 already, so the
-- Guest payload keeps the title it has always had.
--
-- Nothing else moves: `v_in_room` still decides which participant seats the payload lists, and
-- `earth.room_context_title` is untouched. 0999 `earth.room_json` verbatim, with the one changed
-- expression marked below.
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
  v_audio text;
  v_camera text;
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

  if p_viewer is not null then
    v_audio := earth.room_join_check(v_room.id, p_viewer, 'audio');
    v_camera := earth.room_join_check(v_room.id, p_viewer, 'camera');
  elsif p_guest_session_id is not null then
    v_audio := case
                 when v_room.status = 'ended' then 'room_ended'
                 when not earth.flag('GUEST_ROOMS_ENABLED') then 'feature_disabled'
                 when v_room.guests_disabled then 'guests_disabled'
                 else null
               end;
    v_camera := v_audio;
  else
    v_audio := 'not_authenticated';
    v_camera := v_audio;
  end if;

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
    -- 1000: a seat is not membership. Guests keep the title a member's link already named;
    -- everyone else reads the gated one (a group's name for its members, null for outsiders).
    'contextTitle', case
                      when p_guest_session_id is not null then earth.room_context_title(v_room.id, p_viewer)
                      else earth.room_discovery_context_title(v_room.id, p_viewer)
                    end,
    'guestsDisabled', v_room.guests_disabled,
    'title', v_room.title,
    'activeHumanCount', v_room.active_human_count,
    'activeParticipantCount', v_room.active_participant_count,
    'lastActivityAt', to_jsonb(v_room.last_activity_at),
    'canJoinAudio', v_audio is null,
    'canJoinCamera', v_camera is null,
    'joinReason', coalesce(v_audio, v_camera)
  );
end
$$;
