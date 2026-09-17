-- 0999 — fix (audience): a private group's name is its members'; `room_get` must not render it to
-- everyone who can merely discover the room (spec §128 "Private group/chat content never appears in
-- World", §60 participant-aware naming, SCREEN 14; DB_API §3 `room_get` / `earth.room_json`).
-- Reproduced by supabase/tests/src/verify/audience.test.ts and e2e/journeys/05-friend-live.spec.ts.
--
-- 0998 closed this leak on the discovery surfaces by adding `earth.room_discovery_context_title`
-- and using it in `live_candidates` (which feeds Live Home, the Home feed's live payload and the
-- map pins). `earth.room_json` — the payload behind `room_get`, and so behind the /rooms/[id]
-- screen header on web and mobile — kept calling `earth.room_context_title` unconditionally. The
-- moment a group room opens up (spec §58 `Open up -> Friends`, or World), `earth.room_visible_to`
-- admits the publishers' friends, World viewers, Guests and unauthenticated visitors, and every one
-- of them read `contextTitle: "Weekend Crew"` from `room_get` — the name of a private group they
-- are not in, which `public.groups` itself refuses to show them (0170 RLS). The room card said
-- nothing, the room screen said everything.
--
-- `contextTitle` is now the gated title for viewers who are not inside the room, and the full one
-- for those who are — `v_in_room` (a participant seat in `invited`/`waiting`/`active`, a Guest
-- session of this room, or an active member of the room's group) is the same test that already
-- decides which participant seats the payload lists. Nothing changes for members, participants,
-- Guests admitted to the room, or direct rooms (0961 already answers their members only): the
-- outsider's payload simply falls back to `null` and the clients name the room by its publishers
-- (`roomHeaderTitle`). `earth.room_context_title` is untouched, so `room_invite_preview` — where a
-- member deliberately shared the link — still names the group. 0996 `earth.room_json` verbatim,
-- with the one changed line marked below.
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
    -- 0999: the group's name is its members'; everyone outside the room reads the gated title.
    'contextTitle', case
                      when v_in_room then earth.room_context_title(v_room.id, p_viewer)
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
