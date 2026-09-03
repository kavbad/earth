-- 0960 — grants review: the caller gate runs before the rate-limit window (ARCHITECTURE §5;
-- DB_API conventions; spec §114, §128 "Audience permission is server-authoritative").
--
-- Every mutating RPC is executable by `anon` (defence in depth, never authorization) and must fail
-- closed for a visitor with a machine code before it touches any row. Two room RPCs charged the
-- caller's rate-limit window first and asked who the caller was second, so a visitor, a Guest
-- without a seat, an unclaimed credential and a claiming Human each wrote a `private.rate_limits`
-- row (keyed by client address or auth user id) before `not_authenticated` / `guest_not_allowed` /
-- `not_a_human` rolled it back. `supabase/tests/src/verify/grants.test.ts` counts rolled-back writes
-- through `pg_stat_user_tables`, which is how this surfaced. The two bodies below are the 0951
-- definitions with the gate moved in front of `earth.rate_limit_for_caller`; nothing else changes.
-- Same grants as 0330 (create or replace keeps them; restated for the reviewer).

-- ---------------------------------------------------------------------------------------------------
-- 1. room_join (0330, 0951 §8): gate → rate limit → guest branch / Human join.
-- ---------------------------------------------------------------------------------------------------

create or replace function public.room_join(
  room_id uuid,
  media_state public.media_state default 'watching',
  consent_level public.room_visibility default 'invited'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_id uuid := room_id;
  v_media public.media_state := coalesce(media_state, 'watching');
  v_consent public.room_visibility := coalesce(consent_level, 'invited');
  v_me uuid;
  v_room public.rooms%rowtype;
  v_guest uuid;
  v_participant public.room_participants%rowtype;
begin
  -- Who is calling, before anything is written: a visitor gets `not_authenticated`, a credential
  -- without an active Human `not_a_human` / `human_not_active`, a Guest with no seat in this room
  -- `guest_not_allowed` — with no rate-limit row spent on the refusal.
  if v_kind = 'guest' then
    v_guest := earth.current_guest_session_id(v_id);
    if v_guest is null then
      perform earth.raise('guest_not_allowed');
    end if;
  else
    v_me := earth.assert_human();
  end if;
  perform earth.rate_limit_for_caller('room_join', 120, 3600);
  if v_kind = 'guest' then
    if not earth.flag('GUEST_ROOMS_ENABLED') then
      perform earth.raise('feature_disabled');
    end if;
    v_room := earth.assert_room(v_id, true);
    if v_room.status = 'ended' then
      perform earth.raise('room_ended');
    end if;
    if v_room.guests_disabled then
      perform earth.raise('guests_disabled');
    end if;
    select * into v_participant
      from public.room_participants rp
     where rp.room_id = v_room.id and rp.guest_session_id = v_guest and rp.status in ('invited', 'waiting', 'active')
     order by rp.joined_at desc
     limit 1;
    if found then
      update public.room_participants rp
         set status = 'active',
             media_state = v_media,
             role = case when v_media = 'watching' then 'viewer'::public.participant_role else 'participant'::public.participant_role end,
             audience_consent_level = greatest(rp.audience_consent_level, v_room.visibility),
             joined_at = case when rp.status = 'active' then rp.joined_at else earth.utc_now() end
       where rp.id = v_participant.id;
    else
      insert into public.room_participants
        (room_id, guest_session_id, role, media_state, status, audience_consent_level, consent_recorded_at, display_name_snapshot, joined_at)
      select v_room.id, gs.id,
             case when v_media = 'watching' then 'viewer'::public.participant_role else 'participant'::public.participant_role end,
             v_media, 'active', v_room.visibility, earth.utc_now(), gs.display_name, earth.utc_now()
        from public.guest_sessions gs
       where gs.id = v_guest;
    end if;
    return earth.room_json(v_room.id, null, v_guest);
  end if;

  return earth.room_join_human(v_id, v_me, v_media, v_consent, false, null, null);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- 2. room_set_media_state (0330, 0951 §1): gate → rate limit → input validation → seat.
-- ---------------------------------------------------------------------------------------------------

create or replace function public.room_set_media_state(
  room_id uuid,
  media_state public.media_state,
  consent_level public.room_visibility default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_id uuid := room_id;
  v_media public.media_state := media_state;
  v_room public.rooms%rowtype;
  v_participant public.room_participants%rowtype;
  v_consent public.room_visibility;
  v_me uuid;
begin
  -- Who is calling, before anything is written (see room_join above).
  if v_kind = 'guest' then
    if earth.current_guest_session_id(v_id) is null then
      perform earth.raise('not_in_room');
    end if;
  else
    v_me := earth.assert_human();
  end if;
  perform earth.rate_limit_for_caller('room_set_media_state', 240, 3600);
  if v_media is null then
    perform earth.raise('invalid_input', 'media_state is required');
  end if;
  v_room := earth.assert_room(v_id, true);
  if v_room.status = 'ended' then
    perform earth.raise('room_ended');
  end if;
  v_participant := earth.room_active_participant(v_room.id);
  if v_participant.id is null then
    perform earth.raise('not_in_room');
  end if;

  -- "Join audio" / "Join on camera" from a viewer seat (SCREEN 14 "if eligible"): the join policy
  -- and the consent gate of a join apply; under `request` the seat waits for a moderator.
  if v_me is not null
     and v_media <> 'watching'
     and v_participant.media_state = 'watching'
     and v_participant.publish_admitted_at is null
     and v_participant.role not in ('initiator', 'moderator') then
    perform earth.room_join_human(v_room.id, v_me, v_media, coalesce(consent_level, 'invited'), false, null, null);
    return earth.room_evaluate_pending_visibility(v_room.id);
  end if;

  if v_participant.guest_session_id is not null then
    v_consent := greatest(v_participant.audience_consent_level, v_room.visibility);
  else
    v_consent := greatest(v_participant.audience_consent_level, coalesce(consent_level, 'invited'));
    if v_media <> 'watching' and v_consent < v_room.visibility then
      perform earth.raise('consent_required');
    end if;
  end if;

  update public.room_participants rp
     set media_state = v_media,
         audience_consent_level = v_consent,
         consent_recorded_at = case when v_consent is distinct from rp.audience_consent_level then earth.utc_now() else rp.consent_recorded_at end,
         role = case
                  when rp.role in ('initiator', 'moderator') then rp.role
                  when v_media = 'watching' then 'viewer'::public.participant_role
                  else 'participant'::public.participant_role
                end
   where rp.id = v_participant.id;

  if v_me is not null and v_media <> 'watching' and v_participant.media_state = 'watching' then
    perform earth.notify_live(v_room.id, v_me);
  end if;

  return earth.room_evaluate_pending_visibility(v_room.id);
end
$$;

-- Grants unchanged from 0330 (restated: client profile, never PUBLIC).
revoke execute on function public.room_join(uuid, public.media_state, public.room_visibility) from public;
revoke execute on function public.room_set_media_state(uuid, public.media_state, public.room_visibility) from public;
grant execute on function public.room_join(uuid, public.media_state, public.room_visibility) to anon, authenticated, service_role;
grant execute on function public.room_set_media_state(uuid, public.media_state, public.room_visibility) to anon, authenticated, service_role;
