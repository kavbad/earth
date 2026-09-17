-- 0951 — rooms invariant fixes from adversarial verification (spec §33, §58–§62, SCREEN 15–18, §105;
-- ARCHITECTURE §10, §12; DB_API §3). Each finding is reproduced by
-- supabase/tests/src/verify/rooms.test.ts.
--
--   1. The join policy gated only the first entry. A Human who joined `watching` (visibility is all
--      that takes) held an "invited" seat for room_join, and room_set_media_state never looked at
--      the policy at all — so `invited_only` / `group` / `friends` / `request` were bypassed by
--      watching first and switching the camera on. Seats now carry `publish_admitted_at`: the moment
--      the seat passed the policy, was invited (direct rooms, links, Guests) or admitted. The first
--      publish from a seat that was never admitted goes through the same policy as a join
--      (`join_not_allowed`, or `waiting` under `request`); admitted seats toggle freely and come back
--      after a reconnect without re-passing it.
--   2. room_admit activated a `waiting` publisher with whatever consent it had recorded, although the
--      room may have widened while it waited (waiting seats are not publishers, so they never block
--      a widening) — a camera at `world` with a `friends` consent. The seat is now admitted as a
--      viewer when its consent does not cover the room; it publishes once it consents (SCREEN 16).
--   3. room_participant_sync(participant_joined) re-activated a `left` row as it was: on camera
--      beyond a consent recorded before a widening, next to a Human who blocked them since, after
--      losing the group, or from a `waiting` seat. It now re-checks visibility (blocks, group
--      membership, removal), refuses waiting seats, downgrades a publisher whose consent no longer
--      covers the room, and hands a moderator-less room to the returning Human.
--   4. room_media_grant said canPublish for any non-watching seat. It now also requires a Human's
--      recorded consent to cover the room's visibility (spec §105: the token reflects the room and
--      its permissions; a grant never exceeds the seat).
--   5. A `left` seat kept a Human inside a live group room after they left or were removed from
--      the group (visible, and "invited" to publish again). Group rooms now need current membership
--      for former seats, and losing the membership ends the live seat (trigger on group_members),
--      as the blocks trigger of 0360 does for blocks.
--   6. A moderator could eject the initiator by blocking them (0360 removed the blocked side when
--      both moderated) although room_remove_participant refuses it. The lower rank now leaves:
--      initiator > moderator > participant.
--   7. room_set_guests_disabled marked every Guest session removed, so re-enabling Guests left the
--      same credentials refused with `blocked` for good. Disabling now removes the seats only; a
--      moderator removal (room_remove_participant) is still final for the credential.
--   8. GUEST_ROOMS_ENABLED gated guest_session_create only: a Guest already inside kept joining and
--      minting media grants after the flag was turned off. Both refuse with `feature_disabled` now.
--   9. A widening that was pending when FRIENDS_LIVE_EXPANSION_ENABLED / WORLD_LIVE_EXPANSION_ENABLED /
--      PUBLIC_LIVE_ENABLED went off was still applied by the next consent, downgrade or leave.
--      earth.room_evaluate_pending_visibility now drops a pending widening its flag no longer allows.
--
-- Signatures, grants and the rate-limit literals of 0330 / 0730 are unchanged; every replaced
-- function keeps its privileges (create or replace preserves the ACL).

-- ---------------------------------------------------------------------------------------------------
-- 1. The seat remembers that it may publish.
-- ---------------------------------------------------------------------------------------------------

alter table public.room_participants add column publish_admitted_at timestamptz;
comment on column public.room_participants.publish_admitted_at is
  'When the seat passed the join policy, was invited (direct room, link, Guest) or admitted: it may publish without re-passing the policy. Null for a viewer who only watched.';

-- Seats that are admitted from the start: explicit invites, the initiator, Guests (their link is the
-- invitation) and rows inserted straight into an active publishing state (every RPC that inserts one
-- has applied the policy first).
create or replace function earth.room_participants_admit_trigger()
returns trigger
language plpgsql
set search_path = public, earth, private, pg_temp
as $$
begin
  if new.publish_admitted_at is null and (
       new.status = 'invited'
       or new.role in ('initiator', 'moderator')
       or new.guest_session_id is not null
       or (new.status = 'active' and new.media_state <> 'watching')
     ) then
    new.publish_admitted_at := earth.utc_now();
  end if;
  return new;
end
$$;

revoke execute on function earth.room_participants_admit_trigger() from public, anon, authenticated;

create trigger room_participants_admit
  before insert on public.room_participants
  for each row execute function earth.room_participants_admit_trigger();

update public.room_participants rp
   set publish_admitted_at = coalesce(rp.consent_recorded_at, rp.joined_at)
 where rp.publish_admitted_at is null
   and (rp.status = 'invited'
        or rp.role in ('initiator', 'moderator')
        or rp.guest_session_id is not null
        or rp.media_state <> 'watching');

-- ---------------------------------------------------------------------------------------------------
-- 5. Former seats in a live group room need current membership (earth.room_visible_to, 0310).
-- ---------------------------------------------------------------------------------------------------

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
    -- Former participants keep their ended room, and their live room unless it belongs to a group
    -- they are no longer a member of; group members see their group's room.
    if exists (
      select 1 from public.room_participants rp
       where rp.room_id = v_room.id and rp.human_id = viewer_human_id and rp.status = 'left'
    ) and (
      v_room.context_type <> 'group'
      or v_room.status not in ('starting', 'active')
      or earth.is_group_member(v_room.context_id, viewer_human_id)
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

-- ---------------------------------------------------------------------------------------------------
-- 1. earth.room_join_human (0330): the policy applies to every seat that was never admitted.
-- ---------------------------------------------------------------------------------------------------

create or replace function earth.room_join_human(
  p_room_id uuid,
  p_human uuid,
  p_media public.media_state,
  p_consent public.room_visibility,
  p_has_link boolean default false,
  p_policy_override public.room_join_policy default null,
  p_invited_by uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_room public.rooms := earth.assert_room(p_room_id, true);
  v_media public.media_state := coalesce(p_media, 'watching');
  v_existing public.room_participants%rowtype;
  v_invited boolean;
  v_member boolean;
  v_friend boolean;
  v_fof boolean;
  v_policy public.room_join_policy;
  v_status public.participant_status := 'active';
  v_role public.participant_role;
  v_consent public.room_visibility;
  v_was_publishing boolean := false;
  v_now timestamptz := earth.utc_now();
begin
  if not (earth.room_visible_to(v_room.id, p_human) or (p_has_link and not earth.room_blocked_for(v_room.id, p_human))) then
    perform earth.raise('room_not_found');
  end if;
  if v_room.status = 'ended' then
    perform earth.raise('room_ended');
  end if;
  if exists (
    select 1 from public.room_participants rp
     where rp.room_id = v_room.id and rp.human_id = p_human and rp.status = 'removed'
  ) then
    perform earth.raise('join_not_allowed');
  end if;

  select * into v_existing
    from public.room_participants rp
   where rp.room_id = v_room.id and rp.human_id = p_human and rp.status in ('invited', 'waiting', 'active')
   order by rp.joined_at desc
   limit 1;
  v_was_publishing := found and v_existing.status = 'active' and v_existing.media_state <> 'watching';

  -- Invited to publish: an unexpired link, the initiator, an explicit invite row, a seat that was
  -- admitted (it passed the policy, was linked in or was let in by a moderator) — live or left, so
  -- reconnects and "keeping the room open" never depend on the policy. A seat that only ever
  -- watched is not an invitation: watching takes visibility, publishing takes the policy.
  v_invited := p_has_link
    or v_room.initiated_by_human_id = p_human
    or (v_existing.id is not null and (
          v_existing.status = 'invited'
          or v_existing.publish_admitted_at is not null
          or v_existing.role in ('initiator', 'moderator')))
    or exists (
      select 1 from public.room_participants rp
       where rp.room_id = v_room.id and rp.human_id = p_human and rp.status = 'left'
         and (rp.publish_admitted_at is not null or rp.role in ('initiator', 'moderator'))
    );
  v_member := v_room.context_type = 'group' and earth.is_group_member(v_room.context_id, p_human);
  v_friend := earth.room_friend_of_publisher(v_room.id, p_human);
  v_fof := v_friend or earth.room_friend_of_friend_of_publisher(v_room.id, p_human);
  v_policy := coalesce(p_policy_override, v_room.join_policy);

  if v_media <> 'watching' then
    -- Join policy (mirror of joinPolicyAllows).
    case v_policy
      when 'invited_only' then
        if not v_invited then perform earth.raise('join_not_allowed'); end if;
      when 'group' then
        if not (v_invited or v_member) then perform earth.raise('join_not_allowed'); end if;
      when 'friends' then
        if not (v_invited or v_member or v_friend) then perform earth.raise('join_not_allowed'); end if;
      when 'friends_of_friends' then
        if not (v_invited or v_member or v_fof) then perform earth.raise('join_not_allowed'); end if;
      when 'request' then
        if not (v_invited or v_member) then v_status := 'waiting'; end if;
      when 'anyone_with_link' then
        if not v_invited then perform earth.raise('join_not_allowed'); end if;
      when 'anyone' then
        null;
    end case;
    -- Consent gate: audio/camera at the room's visibility needs consent at least that wide.
    v_consent := greatest(coalesce(v_existing.audience_consent_level, 'invited'), coalesce(p_consent, 'invited'));
    if v_consent < v_room.visibility then
      perform earth.raise('consent_required');
    end if;
  else
    v_consent := greatest(coalesce(v_existing.audience_consent_level, 'invited'), coalesce(p_consent, 'invited'));
  end if;

  v_role := case
              when v_room.initiated_by_human_id = p_human then 'initiator'::public.participant_role
              when v_existing.role in ('initiator', 'moderator') then v_existing.role
              when v_media = 'watching' then 'viewer'::public.participant_role
              else 'participant'::public.participant_role
            end;

  if v_existing.id is not null then
    update public.room_participants rp
       set status = v_status,
           media_state = v_media,
           role = v_role,
           audience_consent_level = v_consent,
           consent_recorded_at = case when v_consent is distinct from rp.audience_consent_level then v_now else rp.consent_recorded_at end,
           joined_at = case when rp.status = 'active' then rp.joined_at else v_now end,
           publish_admitted_at = coalesce(
             rp.publish_admitted_at,
             case when v_status = 'active' and (v_media <> 'watching' or p_has_link) then v_now end
           )
     where rp.id = v_existing.id;
  else
    insert into public.room_participants
      (room_id, human_id, role, media_state, status, audience_consent_level, consent_recorded_at, invited_by_human_id, joined_at, publish_admitted_at)
    values
      (v_room.id, p_human, v_role, v_media, v_status, v_consent,
       case when v_media <> 'watching' then v_now else null end, p_invited_by, v_now,
       case when v_status = 'active' and (v_media <> 'watching' or p_has_link) then v_now end);
  end if;

  -- A room without a moderator (guests only, or every moderator gone) is handed to the first Human
  -- who takes a seat (spec §61: Guests cannot own persistent room moderation).
  if v_status = 'active' then
    perform earth.room_transfer_moderator(v_room.id);
  end if;

  -- A Human who starts publishing makes their own friends eligible (spec §59); the dedupe decides.
  if v_status = 'active' and v_media <> 'watching' and not v_was_publishing then
    perform earth.notify_live(v_room.id, p_human);
  end if;

  return earth.room_json(v_room.id, p_human, null);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- 8. room_join (0330): GUEST_ROOMS_ENABLED is a kill switch for Guests already inside.
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
  perform earth.rate_limit_for_caller('room_join', 120, 3600);
  if v_kind = 'guest' then
    v_guest := earth.current_guest_session_id(v_id);
    if v_guest is null then
      perform earth.raise('guest_not_allowed');
    end if;
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

  v_me := earth.assert_human();
  return earth.room_join_human(v_id, v_me, v_media, v_consent, false, null, null);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- 1. room_set_media_state (0330): the first publish from a seat that was never admitted is a join.
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
  perform earth.rate_limit_for_caller('room_set_media_state', 240, 3600);
  if v_media is null then
    perform earth.raise('invalid_input', 'media_state is required');
  end if;
  if v_kind = 'guest' then
    if earth.current_guest_session_id(v_id) is null then
      perform earth.raise('not_in_room');
    end if;
  else
    v_me := earth.assert_human();
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

-- ---------------------------------------------------------------------------------------------------
-- 2. room_admit (0330): admission never puts a seat on camera beyond its consent.
-- ---------------------------------------------------------------------------------------------------

create or replace function public.room_admit(room_id uuid, participant_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human_not_guest();
  v_room public.rooms := earth.assert_room_moderator(room_id, v_me);
  v_participant public.room_participants%rowtype;
  v_now timestamptz := earth.utc_now();
  v_downgrade boolean;
begin
  perform earth.rate_limit_for_caller('room_admit', 240, 3600);
  select * into v_participant
    from public.room_participants rp
   where rp.id = participant_id and rp.room_id = v_room.id;
  if not found then
    perform earth.raise('not_in_room');
  end if;
  if v_participant.status = 'waiting' then
    -- The room may have widened while the seat waited (waiting seats never block a widening): a
    -- Human whose consent no longer covers the room is admitted as a viewer and publishes once they
    -- consent (SCREEN 16), never silently.
    v_downgrade := v_participant.human_id is not null
      and v_participant.media_state <> 'watching'
      and v_participant.audience_consent_level < v_room.visibility;
    update public.room_participants rp
       set status = 'active',
           joined_at = v_now,
           publish_admitted_at = coalesce(rp.publish_admitted_at, v_now),
           media_state = case when v_downgrade then 'watching'::public.media_state else rp.media_state end,
           role = case
                    when v_downgrade and rp.role not in ('initiator', 'moderator') then 'viewer'::public.participant_role
                    else rp.role
                  end
     where rp.id = v_participant.id;
    perform earth.room_transfer_moderator(v_room.id);
    if v_participant.human_id is not null and v_participant.media_state <> 'watching' and not v_downgrade then
      perform earth.notify_live(v_room.id, v_participant.human_id);
    end if;
  elsif v_participant.status = 'active' then
    -- Admitting an active viewer lets them publish without a request.
    update public.room_participants rp
       set publish_admitted_at = coalesce(rp.publish_admitted_at, v_now)
     where rp.id = v_participant.id;
  else
    perform earth.raise('not_in_room');
  end if;
  return earth.room_json(v_room.id, v_me, null);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- 7. room_set_guests_disabled (0330): disabling removes the seats, not the credentials.
-- ---------------------------------------------------------------------------------------------------

create or replace function public.room_set_guests_disabled(room_id uuid, disabled boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human_not_guest();
  v_room public.rooms := earth.assert_room_moderator(room_id, v_me);
  v_disabled boolean := coalesce(disabled, true);
  v_now timestamptz := earth.utc_now();
begin
  perform earth.rate_limit_for_caller('room_set_guests_disabled', 120, 3600);
  update public.rooms r set guests_disabled = v_disabled, last_activity_at = v_now where r.id = v_room.id;
  if v_disabled then
    -- Every Guest seat ends; the sessions stay usable so the same credentials may come back through
    -- the link once Guests are enabled again (a moderator removal is what blocks a credential).
    update public.room_participants rp
       set status = 'removed', left_at = v_now
     where rp.room_id = v_room.id and rp.guest_session_id is not null and rp.status in ('invited', 'waiting', 'active');
  end if;
  perform earth.audit('room_set_guests_disabled', 'room', v_room.id, jsonb_build_object('disabled', v_disabled));
  return earth.room_json(v_room.id, v_me, null);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- 4 + 8. room_media_grant (0330): never beyond the seat's consent; Guests need the flag.
-- ---------------------------------------------------------------------------------------------------

create or replace function public.room_media_grant(room_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_room public.rooms%rowtype;
  v_participant public.room_participants%rowtype;
  v_name text;
begin
  if v_kind = 'visitor' then
    perform earth.raise('not_authenticated');
  end if;
  if v_kind not in ('guest', 'human') then
    perform earth.raise('not_a_human');
  end if;
  if v_kind = 'human' then
    perform earth.assert_human();
  elsif not earth.flag('GUEST_ROOMS_ENABLED') then
    perform earth.raise('feature_disabled');
  end if;
  perform earth.rate_limit_for_caller('room_media_grant', 120, 3600);
  v_room := earth.assert_room(room_id, false);
  if v_room.status = 'ended' then
    perform earth.raise('room_ended');
  end if;
  v_participant := earth.room_active_participant(v_room.id);
  if v_participant.id is null then
    perform earth.raise('not_in_room');
  end if;
  if v_participant.human_id is not null then
    v_name := earth.display_name_of(v_participant.human_id);
  else
    select gs.display_name into v_name from public.guest_sessions gs where gs.id = v_participant.guest_session_id;
  end if;

  return jsonb_build_object(
    'livekitRoom', v_room.id,
    'identity', v_participant.livekit_identity,
    'name', coalesce(v_name, v_participant.display_name_snapshot, 'Earth member'),
    'role', v_participant.role,
    -- Publishing takes a non-watching seat and, for a Human, a consent that covers the room.
    'canPublish', v_participant.media_state <> 'watching'
                  and (v_participant.guest_session_id is not null
                       or v_participant.audience_consent_level >= v_room.visibility),
    'canSubscribe', true,
    'canPublishData', true,
    'ttlSeconds', 7200
  );
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- 3. room_participant_sync (0330): a returning Human is re-checked like a join.
-- ---------------------------------------------------------------------------------------------------

create or replace function public.room_participant_sync(
  room_id uuid,
  livekit_identity text,
  event text,
  at timestamptz default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_at timestamptz := coalesce(at, earth.utc_now());
  v_event text := lower(btrim(coalesce(event, '')));
  v_identity text := btrim(coalesce(livekit_identity, ''));
  v_participant public.room_participants%rowtype;
  v_transferred uuid;
  v_downgrade boolean := false;
begin
  if earth.current_role_kind() <> 'service' then
    perform earth.raise('forbidden');
  end if;
  if v_event not in ('participant_joined', 'participant_left', 'room_finished') then
    perform earth.raise('invalid_input', 'event must be participant_joined, participant_left or room_finished');
  end if;
  v_room := earth.assert_room(room_id, true);

  if v_event = 'room_finished' then
    if v_room.status = 'ended' then
      return jsonb_build_object('roomId', v_room.id, 'event', v_event, 'applied', false, 'ignored', true, 'reason', 'already_ended');
    end if;
    perform earth.room_end_internal(v_room.id, 'livekit_finished');
    return jsonb_build_object('roomId', v_room.id, 'event', v_event, 'applied', true, 'ignored', false, 'reason', null);
  end if;

  if v_identity = '' then
    perform earth.raise('invalid_input', 'livekit_identity is required');
  end if;
  select * into v_participant
    from public.room_participants rp
   where rp.room_id = v_room.id and rp.livekit_identity = v_identity
   order by (rp.status in ('invited', 'waiting', 'active')) desc, rp.joined_at desc, rp.id desc
   limit 1;
  if not found then
    return jsonb_build_object('roomId', v_room.id, 'event', v_event, 'applied', false, 'ignored', true, 'reason', 'unknown_participant');
  end if;
  if v_room.status = 'ended' then
    return jsonb_build_object('roomId', v_room.id, 'participantId', v_participant.id, 'event', v_event, 'applied', false, 'ignored', true, 'reason', 'room_ended');
  end if;

  if v_event = 'participant_joined' then
    if v_participant.status = 'active' then
      return jsonb_build_object('roomId', v_room.id, 'participantId', v_participant.id, 'event', v_event, 'applied', false, 'ignored', true, 'reason', 'already_active');
    end if;
    if v_participant.status = 'removed' then
      return jsonb_build_object('roomId', v_room.id, 'participantId', v_participant.id, 'event', v_event, 'applied', false, 'ignored', true, 'reason', 'removed');
    end if;
    if v_participant.left_at is not null and v_at < v_participant.left_at then
      return jsonb_build_object('roomId', v_room.id, 'participantId', v_participant.id, 'event', v_event, 'applied', false, 'ignored', true, 'reason', 'out_of_order');
    end if;
    if v_participant.guest_session_id is not null and (
         v_room.guests_disabled
         or not earth.flag('GUEST_ROOMS_ENABLED')
         or not exists (select 1 from public.guest_sessions gs where gs.id = v_participant.guest_session_id
                          and gs.removed_at is null and gs.expires_at > v_at)) then
      return jsonb_build_object('roomId', v_room.id, 'participantId', v_participant.id, 'event', v_event, 'applied', false, 'ignored', true, 'reason', 'guest_session_unusable');
    end if;
    if v_participant.human_id is not null then
      -- A waiting seat is admitted by a moderator, never by a media server event.
      if v_participant.status = 'waiting' then
        return jsonb_build_object('roomId', v_room.id, 'participantId', v_participant.id, 'event', v_event, 'applied', false, 'ignored', true, 'reason', 'not_admitted');
      end if;
      -- Blocks, removal and group membership are re-checked as for any join.
      if not earth.room_visible_to(v_room.id, v_participant.human_id) then
        return jsonb_build_object('roomId', v_room.id, 'participantId', v_participant.id, 'event', v_event, 'applied', false, 'ignored', true, 'reason', 'not_visible');
      end if;
      -- The room may have widened while the seat was away: a stale consent never publishes.
      v_downgrade := v_participant.media_state <> 'watching' and v_participant.audience_consent_level < v_room.visibility;
    end if;
    update public.room_participants rp
       set status = 'active',
           left_at = null,
           joined_at = v_at,
           media_state = case when v_downgrade then 'watching'::public.media_state else rp.media_state end,
           role = case
                    when v_downgrade and rp.role not in ('initiator', 'moderator') then 'viewer'::public.participant_role
                    else rp.role
                  end
     where rp.id = v_participant.id;
    perform earth.room_transfer_moderator(v_room.id);
    return jsonb_build_object('roomId', v_room.id, 'participantId', v_participant.id, 'event', v_event, 'applied', true, 'ignored', false, 'reason', null, 'downgraded', v_downgrade);
  end if;

  -- participant_left
  if v_participant.status <> 'active' then
    return jsonb_build_object('roomId', v_room.id, 'participantId', v_participant.id, 'event', v_event, 'applied', false, 'ignored', true,
      'reason', case when v_participant.left_at is not null and v_at < v_participant.left_at then 'out_of_order' else 'not_active' end);
  end if;
  if v_at < v_participant.joined_at then
    return jsonb_build_object('roomId', v_room.id, 'participantId', v_participant.id, 'event', v_event, 'applied', false, 'ignored', true, 'reason', 'out_of_order');
  end if;
  update public.room_participants rp
     set status = 'left', left_at = v_at
   where rp.id = v_participant.id;
  if v_participant.human_id is not null and v_participant.role in ('initiator', 'moderator') then
    v_transferred := earth.room_transfer_moderator(v_room.id);
  end if;
  perform earth.room_evaluate_pending_visibility(v_room.id);
  return jsonb_build_object('roomId', v_room.id, 'participantId', v_participant.id, 'event', v_event, 'applied', true, 'ignored', false, 'reason', null, 'transferredTo', v_transferred);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- 9. earth.room_evaluate_pending_visibility (0310): a widening its flag no longer allows is dropped.
-- ---------------------------------------------------------------------------------------------------

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

  -- The flags that gated the request (room_set_visibility) still gate its application.
  if (v_room.pending_visibility >= 'friends' and not earth.flag('FRIENDS_LIVE_EXPANSION_ENABLED'))
     or (v_room.pending_visibility >= 'neighborhood'
         and not (earth.flag('WORLD_LIVE_EXPANSION_ENABLED') and earth.flag('PUBLIC_LIVE_ENABLED'))) then
    update public.rooms r
       set pending_visibility = null,
           pending_join_policy = null,
           pending_area_precision = null,
           pending_area_id = null,
           last_activity_at = earth.utc_now()
     where r.id = v_room.id;
    return earth.room_visibility_change_json(false, v_room.visibility, null, '{}'::uuid[]);
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
-- 6. earth.blocks_apply_to_rooms_trigger (0360): the lower rank leaves (initiator > moderator > seat).
-- ---------------------------------------------------------------------------------------------------

create or replace function earth.blocks_apply_to_rooms_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_now timestamptz := earth.utc_now();
  v_pair record;
  v_leaver uuid;
  v_status public.participant_status;
begin
  for v_pair in
    select rp_blocker.room_id,
           case rp_blocker.role when 'initiator' then 2 when 'moderator' then 1 else 0 end as blocker_rank,
           case rp_blocked.role when 'initiator' then 2 when 'moderator' then 1 else 0 end as blocked_rank
      from public.room_participants rp_blocker
      join public.room_participants rp_blocked
        on rp_blocked.room_id = rp_blocker.room_id
       and rp_blocked.human_id = new.blocked_human_id
       and rp_blocked.status in ('invited', 'waiting', 'active')
      join public.rooms r on r.id = rp_blocker.room_id and r.status in ('starting', 'active')
     where rp_blocker.human_id = new.blocker_human_id
       and rp_blocker.status in ('invited', 'waiting', 'active')
  loop
    if v_pair.blocked_rank > v_pair.blocker_rank then
      v_leaver := new.blocker_human_id;
      v_status := 'left';
    else
      v_leaver := new.blocked_human_id;
      v_status := 'removed';
    end if;
    update public.room_participants rp
       set status = v_status, left_at = v_now
     where rp.room_id = v_pair.room_id and rp.human_id = v_leaver and rp.status in ('invited', 'waiting', 'active');
    update public.human_presence hp set active_room_id = null
     where hp.human_id = v_leaver and hp.active_room_id = v_pair.room_id;
    perform earth.room_transfer_moderator(v_pair.room_id);
    perform earth.room_evaluate_pending_visibility(v_pair.room_id);
    perform earth.audit('room_block_applied', 'room', v_pair.room_id,
      jsonb_build_object('blockerHumanId', new.blocker_human_id, 'blockedHumanId', new.blocked_human_id, 'leaver', v_leaver, 'status', v_status));
  end loop;
  return new;
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- 5. Losing a group membership ends the seat in the group's live room (spec §57 step 1: membership).
-- ---------------------------------------------------------------------------------------------------

create or replace function earth.group_members_apply_to_rooms_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_now timestamptz := earth.utc_now();
  v_room_id uuid;
  v_seat public.room_participants%rowtype;
begin
  if old.status <> 'active' or new.status = 'active' then
    return new;
  end if;
  for v_room_id in
    select r.id
      from public.rooms r
     where r.context_type = 'group' and r.context_id = new.group_id and r.status in ('starting', 'active')
       for update
  loop
    select * into v_seat
      from public.room_participants rp
     where rp.room_id = v_room_id and rp.human_id = new.human_id and rp.status in ('invited', 'waiting', 'active')
     order by rp.joined_at desc
     limit 1;
    if not found then
      continue;
    end if;
    update public.room_participants rp
       set status = 'left', left_at = v_now
     where rp.room_id = v_room_id and rp.human_id = new.human_id and rp.status in ('invited', 'waiting', 'active');
    update public.human_presence hp set active_room_id = null
     where hp.human_id = new.human_id and hp.active_room_id = v_room_id;
    if v_seat.role in ('initiator', 'moderator') then
      perform earth.room_transfer_moderator(v_room_id);
    end if;
    perform earth.room_evaluate_pending_visibility(v_room_id);
    perform earth.audit('room_membership_lost', 'room', v_room_id,
      jsonb_build_object('humanId', new.human_id, 'groupId', new.group_id, 'membershipStatus', new.status));
  end loop;
  return new;
end
$$;

revoke execute on function earth.group_members_apply_to_rooms_trigger() from public, anon, authenticated;

create trigger group_members_apply_to_rooms
  after update of status on public.group_members
  for each row execute function earth.group_members_apply_to_rooms_trigger();

-- Fail loudly if a later range drops what this fix depends on.
do $$
begin
  if not exists (
    select 1 from information_schema.columns c
     where c.table_schema = 'public' and c.table_name = 'room_participants' and c.column_name = 'publish_admitted_at'
  ) then
    raise exception '0951: room_participants.publish_admitted_at is missing';
  end if;
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.room_participants'::regclass and t.tgname = 'room_participants_admit' and not t.tgisinternal
  ) then
    raise exception '0951: trigger room_participants_admit on public.room_participants is missing';
  end if;
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.group_members'::regclass and t.tgname = 'group_members_apply_to_rooms' and not t.tgisinternal
  ) then
    raise exception '0951: trigger group_members_apply_to_rooms on public.group_members is missing';
  end if;
end
$$;
