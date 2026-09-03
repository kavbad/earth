-- 0330 — room, guest and Live RPCs (DB_API §3 "RPCs"; spec §57–§62, §81, §83; ARCHITECTURE §10).
--
-- Every RPC: security definer, fixed search_path, caller validated through earth.current_role_kind()
-- / earth.assert_human(), mutations rate limited with earth.rate_limit_for_caller, errors only through
-- earth.raise('<code>'), jsonb results shaped like packages/domain/src/dto/rooms.ts. Every mutation
-- locks the room row first (`for update`) so participant changes and the counters of 0310 are
-- serialized per room. Parameters keep the contract names; locals are `v_`-prefixed and columns are
-- table-qualified so names never collide.

-- ---------------------------------------------------------------------------------------------------
-- Internals
-- ---------------------------------------------------------------------------------------------------

-- The room row (locked when `p_lock`), or raises `room_not_found`.
create or replace function earth.assert_room(p_room_id uuid, p_lock boolean default false)
returns public.rooms
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
begin
  if p_room_id is not null then
    if p_lock then
      select * into v_room from public.rooms r where r.id = p_room_id for update;
    else
      select * into v_room from public.rooms r where r.id = p_room_id;
    end if;
  end if;
  if v_room.id is null then
    perform earth.raise('room_not_found');
  end if;
  return v_room;
end
$$;

-- The caller's active Human id, refusing Guests with `guest_not_allowed` (moderator and
-- invite affordances are Human-only, SCREEN 18).
create or replace function earth.assert_human_not_guest()
returns uuid
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
begin
  if earth.current_role_kind() = 'guest' then
    perform earth.raise('guest_not_allowed');
  end if;
  return earth.assert_human();
end
$$;

-- The locked room in which `p_me` is an active moderator, or raises `room_not_found` /
-- `room_ended` / `not_in_room` / `not_a_moderator`.
create or replace function earth.assert_room_moderator(p_room_id uuid, p_me uuid)
returns public.rooms
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_room public.rooms := earth.assert_room(p_room_id, true);
  v_participant public.room_participants%rowtype;
begin
  if not earth.room_visible_to(v_room.id, p_me) then
    perform earth.raise('room_not_found');
  end if;
  if v_room.status = 'ended' then
    perform earth.raise('room_ended');
  end if;
  select * into v_participant
    from public.room_participants rp
   where rp.room_id = v_room.id and rp.human_id = p_me and rp.status = 'active'
   order by rp.joined_at desc
   limit 1;
  if not found then
    perform earth.raise('not_in_room');
  end if;
  if v_participant.role not in ('initiator', 'moderator') then
    perform earth.raise('not_a_moderator');
  end if;
  return v_room;
end
$$;

-- Joins (or re-joins) a Human into a room with the join policy and consent rules of ARCHITECTURE §10
-- and the domain mirror canJoinWithMedia. `p_has_link` marks an unexpired room invite (link
-- privilege); `p_policy_override` is the invite's override. Returns `RoomDto`.
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

  -- Invited: an explicit invite row, an unexpired link, the initiator coming back, or a former seat
  -- (left, never removed) — reconnects and "keeping the room open" must not depend on the policy.
  v_invited := p_has_link
    or (v_existing.id is not null and v_existing.status in ('invited', 'active'))
    or v_room.initiated_by_human_id = p_human
    or exists (
      select 1 from public.room_participants rp
       where rp.room_id = v_room.id and rp.human_id = p_human and rp.status = 'left'
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
           joined_at = case when rp.status = 'active' then rp.joined_at else v_now end
     where rp.id = v_existing.id;
  else
    insert into public.room_participants
      (room_id, human_id, role, media_state, status, audience_consent_level, consent_recorded_at, invited_by_human_id, joined_at)
    values
      (v_room.id, p_human, v_role, v_media, v_status, v_consent,
       case when v_media <> 'watching' then v_now else null end, p_invited_by, v_now);
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

-- The area a room takes when it opens to neighborhood / city / world, from a Human's context
-- (spec §76: city or neighborhood, never device coordinates).
create or replace function earth.room_area_for(
  p_human uuid,
  p_visibility public.room_visibility,
  out out_area_id uuid,
  out out_precision public.area_precision
)
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_ctx public.human_context%rowtype;
  v_city uuid;
begin
  out_area_id := null;
  out_precision := null;
  if p_visibility < 'neighborhood' then
    return;
  end if;
  select * into v_ctx from public.human_context hc where hc.human_id = p_human;
  v_city := coalesce(v_ctx.current_city_id, earth.area_ancestor_of_type(v_ctx.current_area_id, 'city'), v_ctx.home_city_id);
  if p_visibility = 'neighborhood' and v_ctx.current_area_id is not null then
    out_area_id := v_ctx.current_area_id;
    out_precision := case
                       when (select a.type from public.areas a where a.id = v_ctx.current_area_id) = 'neighborhood'
                       then 'neighborhood'::public.area_precision
                       else 'city'::public.area_precision
                     end;
    return;
  end if;
  if v_city is not null then
    out_area_id := v_city;
    out_precision := 'city';
    return;
  end if;
  if p_visibility = 'neighborhood' and v_ctx.current_area_id is not null then
    out_area_id := v_ctx.current_area_id;
    out_precision := 'neighborhood';
    return;
  end if;
  if p_visibility <> 'world' then
    perform earth.raise('area_not_found');
  end if;
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- room_start / room_get
-- ---------------------------------------------------------------------------------------------------

create or replace function public.room_start(
  context_type public.room_context_type,
  context_id uuid default null,
  title text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_type public.room_context_type := context_type;
  v_context uuid := context_id;
  v_title text := nullif(btrim(coalesce(title, '')), '');
  v_room public.rooms%rowtype;
  v_group public.groups%rowtype;
  v_conversation public.conversations%rowtype;
  v_other uuid;
  v_visibility public.room_visibility;
  v_policy public.room_join_policy;
  v_now timestamptz := earth.utc_now();
  v_place_area uuid;
begin
  if v_type is null then
    perform earth.raise('invalid_input', 'context_type is required');
  end if;
  if v_title is not null and length(v_title) > 80 then
    perform earth.raise('invalid_input', 'title is longer than 80 characters');
  end if;

  if v_type = 'group' then
    v_group := earth.assert_group(v_context);
    if not earth.is_group_member(v_group.id, v_me) then
      perform earth.raise('not_a_member');
    end if;
    if v_group.status <> 'active' then
      perform earth.raise('group_not_found');
    end if;
    -- Serialize starts per group.
    perform 1 from public.groups g where g.id = v_group.id for update;
    select c.id into v_conversation.id from public.conversations c where c.group_id = v_group.id;
  elsif v_type = 'direct' then
    if v_context is null or not earth.is_conversation_member(v_context, v_me) then
      perform earth.raise('conversation_not_found');
    end if;
    select * into v_conversation from public.conversations c where c.id = v_context for update;
    if v_conversation.type <> 'direct' then
      perform earth.raise('invalid_input', 'a direct room needs a direct conversation');
    end if;
    v_other := earth.direct_other_member(v_conversation.id, v_me);
    if earth.is_blocked_either(v_me, v_other) then
      perform earth.raise('blocked');
    end if;
  elsif v_type = 'standalone' then
    v_context := null;
    if not earth.flag('FRIENDS_LIVE_EXPANSION_ENABLED') then
      perform earth.raise('feature_disabled');
    end if;
  elsif v_type = 'place' then
    select p.area_id into v_place_area from public.places p where p.id = v_context;
    if v_place_area is null then
      perform earth.raise('invalid_input', 'context_id must be a place');
    end if;
  elsif v_context is null then
    perform earth.raise('invalid_input', 'context_id is required');
  end if;

  -- Existing live room for the context: join it (watching) instead of creating a second one.
  if v_context is not null then
    select * into v_room
      from public.rooms r
     where r.context_type = v_type and r.context_id = v_context and r.status in ('starting', 'active')
     order by r.created_at desc
     limit 1
       for update;
    if found then
      perform earth.room_join_human(v_room.id, v_me, 'watching', 'invited', false, null, null);
      return jsonb_build_object('room', earth.room_json(v_room.id, v_me, null), 'created', false);
    end if;
  end if;

  perform earth.rate_limit_for_caller('room_start', 20, 3600);

  v_visibility := earth.default_room_visibility(v_type);
  v_policy := earth.default_room_join_policy(v_type);

  insert into public.rooms
    (context_type, context_id, initiated_by_human_id, visibility, join_policy, status, title,
     place_id, area_id, area_precision, created_at, started_at, last_activity_at, humans_absent_since)
  values
    (v_type, v_context, v_me, v_visibility, v_policy, 'active', v_title,
     case when v_type = 'place' then v_context else null end,
     v_place_area,
     case when v_place_area is not null then 'place'::public.area_precision else 'none'::public.area_precision end,
     v_now, v_now, v_now, v_now)
  returning * into v_room;

  insert into public.room_participants
    (room_id, human_id, role, media_state, status, audience_consent_level, consent_recorded_at, joined_at)
  values
    (v_room.id, v_me, 'initiator', 'camera', 'active', v_visibility, v_now, v_now);

  if v_type = 'group' then
    update public.groups g set active_room_id = v_room.id, last_activity_at = v_now where g.id = v_group.id;
    update public.conversations c set active_room_id = v_room.id where c.group_id = v_group.id;
    perform earth.system_message(
      v_conversation.id, v_me,
      coalesce(earth.display_name_of(v_me), 'Someone') || ' started a video'
    );
  elsif v_type = 'direct' then
    update public.conversations c set active_room_id = v_room.id where c.id = v_conversation.id;
    -- Both members are invited (the initiator is already active).
    insert into public.room_participants
      (room_id, human_id, role, media_state, status, audience_consent_level, invited_by_human_id, joined_at)
    select v_room.id, cm.human_id, 'participant', 'watching', 'invited', 'invited', v_me, v_now
      from public.conversation_members cm
     where cm.conversation_id = v_conversation.id and cm.human_id <> v_me;
  end if;

  perform earth.notify_live(v_room.id, null);
  perform earth.audit('room_start', 'room', v_room.id, jsonb_build_object('contextType', v_type, 'contextId', v_context));

  return jsonb_build_object('room', earth.room_json(v_room.id, v_me, null), 'created', true);
end
$$;

create or replace function public.room_get(room_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_id uuid := room_id;
  v_me uuid;
  v_guest uuid;
begin
  if v_id is null then
    perform earth.raise('room_not_found');
  end if;
  if v_kind = 'guest' then
    v_guest := earth.current_guest_session_id(v_id);
    if v_guest is null then
      perform earth.raise('room_not_found');
    end if;
    return earth.room_json(v_id, null, v_guest);
  end if;
  if v_kind = 'service' then
    if not exists (select 1 from public.rooms r where r.id = v_id) then
      perform earth.raise('room_not_found');
    end if;
    return earth.room_json(v_id, null, null);
  end if;
  v_me := case when v_kind = 'human' then earth.current_human() else null end;
  if not earth.room_visible_to(v_id, v_me) then
    perform earth.raise('room_not_found');
  end if;
  return earth.room_json(v_id, v_me, null);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Joining, media state, consent
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

create or replace function public.room_invite_join(
  token text,
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
  v_me uuid := earth.assert_human();
  v_invite public.room_invites%rowtype;
  v_result jsonb;
begin
  perform earth.rate_limit_for_caller('room_invite_join', 10, 600);
  if token is null or token = '' then
    perform earth.raise('invite_invalid');
  end if;
  v_invite := earth.assert_room_invite_usable(earth.sha256_hex(token));
  v_result := earth.room_join_human(
    v_invite.room_id, v_me, coalesce(media_state, 'watching'), coalesce(consent_level, 'invited'),
    true, v_invite.join_policy_override, v_invite.created_by_human_id
  );
  update public.room_invites ri set use_count = ri.use_count + 1 where ri.id = v_invite.id;
  return v_result;
end
$$;

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

create or replace function public.room_consent(room_id uuid, level public.room_visibility)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_me uuid;
  v_room public.rooms%rowtype;
  v_participant public.room_participants%rowtype;
  v_level public.room_visibility := level;
begin
  if v_kind = 'guest' then
    perform earth.raise('guest_not_allowed');
  end if;
  v_me := earth.assert_human();
  perform earth.rate_limit_for_caller('room_consent', 240, 3600);
  if v_level is null then
    perform earth.raise('invalid_input', 'level is required');
  end if;
  v_room := earth.assert_room(room_id, true);
  if v_room.status = 'ended' then
    perform earth.raise('room_ended');
  end if;
  v_participant := earth.room_active_participant(v_room.id);
  if v_participant.id is null then
    perform earth.raise('not_in_room');
  end if;

  update public.room_participants rp
     set audience_consent_level = greatest(rp.audience_consent_level, v_level),
         consent_recorded_at = case when v_level > rp.audience_consent_level then earth.utc_now() else rp.consent_recorded_at end
   where rp.id = v_participant.id;

  return earth.room_evaluate_pending_visibility(v_room.id);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Moderator controls (spec §81; SCREEN 15)
-- ---------------------------------------------------------------------------------------------------

create or replace function public.room_set_visibility(
  room_id uuid,
  visibility public.room_visibility,
  join_policy public.room_join_policy default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human_not_guest();
  v_room public.rooms := earth.assert_room_moderator(room_id, v_me);
  v_visibility public.room_visibility := visibility;
  v_policy public.room_join_policy := join_policy;
  v_allowed public.room_join_policy[];
  v_pending uuid[];
  v_area uuid;
  v_precision public.area_precision;
  v_now timestamptz := earth.utc_now();
begin
  perform earth.rate_limit_for_caller('room_set_visibility', 120, 3600);
  if v_visibility is null then
    perform earth.raise('invalid_input', 'visibility is required');
  end if;
  -- Open up options per context (openUpOptionsFor): `group` only for group rooms, never `invited` on them.
  if (v_visibility = 'group') <> (v_room.context_type = 'group') and v_visibility in ('group', 'invited') then
    perform earth.raise('visibility_not_allowed');
  end if;

  v_allowed := earth.allowed_join_policies(v_visibility, v_room.context_type);
  if v_policy is null then
    v_policy := v_allowed[1];
  elsif not (v_policy = any (v_allowed)) then
    perform earth.raise('invalid_input', 'join policy is not offered for this visibility');
  end if;

  -- Narrowing (or keeping the level): immediate, clears any pending widening.
  if v_visibility <= v_room.visibility then
    update public.rooms r
       set visibility = v_visibility,
           join_policy = v_policy,
           pending_visibility = null,
           pending_join_policy = null,
           pending_area_precision = null,
           pending_area_id = null,
           area_id = case when v_visibility < 'neighborhood' and r.area_precision <> 'place' then null else r.area_id end,
           area_precision = case when v_visibility < 'neighborhood' and r.area_precision <> 'place' then 'none' else r.area_precision end,
           last_activity_at = v_now
     where r.id = v_room.id;
    perform earth.audit('room_set_visibility', 'room', v_room.id, jsonb_build_object('visibility', v_visibility, 'joinPolicy', v_policy));
    return earth.room_visibility_change_json(true, v_visibility, null, '{}'::uuid[]);
  end if;

  -- Widening: feature flags, area from the moderator's context, then consent of every publisher.
  if v_visibility >= 'friends' and not earth.flag('FRIENDS_LIVE_EXPANSION_ENABLED') then
    perform earth.raise('feature_disabled');
  end if;
  if v_visibility >= 'neighborhood'
     and not (earth.flag('WORLD_LIVE_EXPANSION_ENABLED') and earth.flag('PUBLIC_LIVE_ENABLED')) then
    perform earth.raise('feature_disabled');
  end if;
  select * into v_area, v_precision from earth.room_area_for(v_me, v_visibility);

  -- Opening up is the moderator's own consent.
  update public.room_participants rp
     set audience_consent_level = greatest(rp.audience_consent_level, v_visibility),
         consent_recorded_at = case when v_visibility > rp.audience_consent_level then v_now else rp.consent_recorded_at end
   where rp.room_id = v_room.id and rp.human_id = v_me and rp.status = 'active';

  v_pending := earth.room_pending_participant_ids(v_room.id, v_visibility);
  if cardinality(v_pending) > 0 then
    update public.rooms r
       set pending_visibility = v_visibility,
           pending_join_policy = v_policy,
           pending_area_id = v_area,
           pending_area_precision = v_precision,
           last_activity_at = v_now
     where r.id = v_room.id;
    return earth.room_visibility_change_json(false, v_room.visibility, v_visibility, v_pending);
  end if;

  update public.rooms r
     set visibility = v_visibility,
         join_policy = v_policy,
         area_id = coalesce(v_area, r.area_id),
         area_precision = coalesce(v_precision, r.area_precision),
         pending_visibility = null,
         pending_join_policy = null,
         pending_area_precision = null,
         pending_area_id = null,
         last_activity_at = v_now
   where r.id = v_room.id;
  perform earth.notify_live(v_room.id, null);
  perform earth.audit('room_set_visibility', 'room', v_room.id, jsonb_build_object('visibility', v_visibility, 'joinPolicy', v_policy));
  return earth.room_visibility_change_json(true, v_visibility, null, '{}'::uuid[]);
end
$$;

create or replace function public.room_set_join_policy(room_id uuid, join_policy public.room_join_policy)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human_not_guest();
  v_room public.rooms := earth.assert_room_moderator(room_id, v_me);
  v_policy public.room_join_policy := join_policy;
begin
  perform earth.rate_limit_for_caller('room_set_join_policy', 120, 3600);
  if v_policy is null then
    perform earth.raise('invalid_input', 'join_policy is required');
  end if;
  if not (v_policy = any (earth.allowed_join_policies(v_room.visibility, v_room.context_type))) then
    perform earth.raise('invalid_input', 'join policy is not offered for this visibility');
  end if;
  update public.rooms r set join_policy = v_policy, last_activity_at = earth.utc_now() where r.id = v_room.id;
  perform earth.audit('room_set_join_policy', 'room', v_room.id, jsonb_build_object('joinPolicy', v_policy));
  return earth.room_json(v_room.id, v_me, null);
end
$$;

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
    update public.room_participants rp
       set status = 'removed', left_at = v_now
     where rp.room_id = v_room.id and rp.guest_session_id is not null and rp.status in ('invited', 'waiting', 'active');
    update public.guest_sessions gs
       set removed_at = coalesce(gs.removed_at, v_now)
     where gs.room_id = v_room.id and gs.removed_at is null;
  end if;
  perform earth.audit('room_set_guests_disabled', 'room', v_room.id, jsonb_build_object('disabled', v_disabled));
  return earth.room_json(v_room.id, v_me, null);
end
$$;

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
begin
  perform earth.rate_limit_for_caller('room_admit', 240, 3600);
  select * into v_participant
    from public.room_participants rp
   where rp.id = participant_id and rp.room_id = v_room.id;
  if not found then
    perform earth.raise('not_in_room');
  end if;
  if v_participant.status = 'waiting' then
    update public.room_participants rp
       set status = 'active', joined_at = earth.utc_now()
     where rp.id = v_participant.id;
    if v_participant.human_id is not null and v_participant.media_state <> 'watching' then
      perform earth.notify_live(v_room.id, v_participant.human_id);
    end if;
  elsif v_participant.status <> 'active' then
    perform earth.raise('not_in_room');
  end if;
  return earth.room_json(v_room.id, v_me, null);
end
$$;

create or replace function public.room_leave(room_id uuid)
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
  v_transferred uuid;
  v_now timestamptz := earth.utc_now();
begin
  if v_kind = 'guest' then
    if earth.current_guest_session_id(room_id) is null then
      perform earth.raise('not_in_room');
    end if;
  else
    perform earth.assert_human();
  end if;
  perform earth.rate_limit_for_caller('room_leave', 240, 3600);
  v_room := earth.assert_room(room_id, true);
  v_participant := earth.room_caller_participant(v_room.id);
  if v_participant.id is null then
    perform earth.raise('not_in_room');
  end if;

  update public.room_participants rp
     set status = 'left', left_at = v_now
   where rp.id = v_participant.id;
  update public.human_presence hp set active_room_id = null
   where v_participant.human_id is not null and hp.human_id = v_participant.human_id and hp.active_room_id = v_room.id;

  if v_participant.human_id is not null and v_participant.role in ('initiator', 'moderator') and v_room.status <> 'ended' then
    v_transferred := earth.room_transfer_moderator(v_room.id);
  end if;
  if v_room.status <> 'ended' then
    perform earth.room_evaluate_pending_visibility(v_room.id);
  end if;

  return jsonb_build_object('transferredTo', v_transferred, 'roomId', v_room.id);
end
$$;

create or replace function public.room_end(room_id uuid, reason text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human_not_guest();
  v_room public.rooms := earth.assert_room_moderator(room_id, v_me);
begin
  perform earth.rate_limit_for_caller('room_end', 120, 3600);
  perform earth.room_end_internal(v_room.id, coalesce(nullif(btrim(coalesce(reason, '')), ''), 'moderator'));
  return earth.room_json(v_room.id, v_me, null);
end
$$;

create or replace function public.room_remove_participant(
  room_id uuid,
  participant_id uuid,
  block_from_room boolean default false
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human_not_guest();
  v_room public.rooms := earth.assert_room_moderator(room_id, v_me);
  v_target public.room_participants%rowtype;
  v_session public.guest_sessions%rowtype;
  v_block boolean := coalesce(block_from_room, false);
  v_now timestamptz := earth.utc_now();
  v_my_role public.participant_role;
begin
  perform earth.rate_limit_for_caller('room_remove_participant', 120, 3600);
  select * into v_target
    from public.room_participants rp
   where rp.id = participant_id and rp.room_id = v_room.id;
  if not found or v_target.status not in ('invited', 'waiting', 'active') then
    perform earth.raise('not_in_room');
  end if;
  if v_target.human_id = v_me then
    perform earth.raise('invalid_input', 'use room_leave to leave a room');
  end if;
  select rp.role into v_my_role
    from public.room_participants rp
   where rp.room_id = v_room.id and rp.human_id = v_me and rp.status = 'active'
   limit 1;
  if v_target.role in ('initiator', 'moderator') and v_my_role <> 'initiator' then
    perform earth.raise('forbidden');
  end if;

  update public.room_participants rp
     set status = 'removed', left_at = v_now
   where rp.id = v_target.id;

  if v_target.guest_session_id is not null then
    update public.guest_sessions gs
       set removed_at = coalesce(gs.removed_at, v_now),
           blocked = gs.blocked or v_block
     where gs.id = v_target.guest_session_id
    returning * into v_session;
    if v_block and v_session.device_fingerprint_hash is not null then
      insert into public.room_blocked_fingerprints (room_id, fingerprint_hash, blocked_by_human_id, guest_session_id)
      values (v_room.id, v_session.device_fingerprint_hash, v_me, v_session.id)
      on conflict on constraint room_blocked_fingerprints_pkey do nothing;
    end if;
  else
    update public.human_presence hp set active_room_id = null
     where hp.human_id = v_target.human_id and hp.active_room_id = v_room.id;
  end if;

  perform earth.room_evaluate_pending_visibility(v_room.id);
  perform earth.audit('room_remove_participant', 'room', v_room.id, jsonb_build_object(
    'participantId', v_target.id, 'humanId', v_target.human_id, 'guestSessionId', v_target.guest_session_id, 'block', v_block
  ));
  return earth.room_json(v_room.id, v_me, null);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Room invites (spec §35, §112 `/live/:token`; SCREEN 17)
-- ---------------------------------------------------------------------------------------------------

create or replace function public.room_invite_create(
  room_id uuid,
  expires_in_seconds integer default null,
  join_policy_override public.room_join_policy default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_me uuid;
  v_room public.rooms%rowtype;
  v_participant public.room_participants%rowtype;
  v_seconds integer := coalesce(expires_in_seconds, 24 * 3600);
  v_override public.room_join_policy := join_policy_override;
  v_token text;
  v_invite public.room_invites%rowtype;
begin
  if v_kind = 'guest' then
    perform earth.raise('guest_not_allowed');
  end if;
  v_me := earth.assert_human();
  perform earth.rate_limit_for_caller('room_invite_create', 20, 3600);
  v_room := earth.assert_room(room_id, false);
  if not earth.room_visible_to(v_room.id, v_me) then
    perform earth.raise('room_not_found');
  end if;
  if v_room.status = 'ended' then
    perform earth.raise('room_ended');
  end if;
  v_participant := earth.room_active_participant(v_room.id);
  if v_participant.id is null then
    perform earth.raise('not_in_room');
  end if;
  if v_seconds < 60 or v_seconds > 24 * 3600 then
    perform earth.raise('invalid_input', 'expires_in_seconds must be between 60 seconds and 24 hours');
  end if;
  if v_override is not null then
    if v_participant.role not in ('initiator', 'moderator') then
      perform earth.raise('not_a_moderator');
    end if;
    if v_override <> 'anyone_with_link'
       and not (v_override = any (earth.allowed_join_policies(v_room.visibility, v_room.context_type))) then
      perform earth.raise('invalid_input', 'join policy override is not offered for this visibility');
    end if;
  end if;

  v_token := earth.random_token();
  insert into public.room_invites (room_id, token_hash, created_by_human_id, join_policy_override, expires_at)
  values (v_room.id, earth.sha256_hex(v_token), v_me, v_override, earth.utc_now() + make_interval(secs => v_seconds))
  returning * into v_invite;

  return jsonb_build_object(
    'token', v_token,
    'url', rtrim(coalesce(earth.setting('web_origin'), 'https://earth.social'), '/') || '/live/' || v_token,
    'expiresAt', to_jsonb(v_invite.expires_at),
    'inviteId', v_invite.id,
    'roomId', v_room.id
  );
end
$$;

create or replace function public.room_invite_preview(token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_viewer uuid := earth.current_human();
  v_invite public.room_invites%rowtype;
  v_room public.rooms%rowtype;
  v_usability text;
  v_policy public.room_join_policy;
  v_participants jsonb;
begin
  perform earth.rate_limit_for_caller('room_invite_preview', 60, 60);
  if token is null or token = '' then
    perform earth.raise('invite_invalid');
  end if;
  select * into v_invite from public.room_invites ri where ri.token_hash = earth.sha256_hex(token);
  if not found then
    perform earth.raise('invite_invalid');
  end if;
  select * into v_room from public.rooms r where r.id = v_invite.room_id;
  v_usability := earth.room_invite_usability(v_invite, v_room.status);
  v_policy := coalesce(v_invite.join_policy_override, v_room.join_policy);

  select coalesce(jsonb_agg(jsonb_build_object(
           'displayName', coalesce(p.display_name, gs.display_name, rp.display_name_snapshot, 'Earth member'),
           'avatarUrl', earth.public_media_url(p.avatar_media_id),
           'isGuest', rp.guest_session_id is not null
         ) order by rp.joined_at, rp.id), '[]'::jsonb)
    into v_participants
    from public.room_participants rp
    left join public.public_identities p on p.human_id = rp.human_id
    left join public.guest_sessions gs on gs.id = rp.guest_session_id
   where rp.room_id = v_room.id
     and rp.status = 'active'
     and rp.media_state <> 'watching'
     and not earth.is_blocked_either(v_viewer, rp.human_id);

  return jsonb_build_object(
    'roomId', v_room.id,
    'contextTitle', earth.room_context_title(v_room.id, v_viewer),
    'visibility', v_room.visibility,
    'joinPolicy', v_policy,
    'participants', v_participants,
    'invitedByDisplayName', earth.display_name_of(v_invite.created_by_human_id),
    'guestsAllowed', earth.flag('GUEST_ROOMS_ENABLED') and not v_room.guests_disabled and v_usability = 'ok',
    'ended', v_usability <> 'ok'
  );
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Guests (spec §34, §42–§43, SCREEN 17–19; ARCHITECTURE §4)
-- ---------------------------------------------------------------------------------------------------

create or replace function public.guest_session_create(
  token text,
  display_name text,
  device_fingerprint_hash text default null,
  media_state public.media_state default 'audio'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_uid uuid := auth.uid();
  v_name text := nullif(btrim(coalesce(display_name, '')), '');
  v_fingerprint text := nullif(btrim(coalesce(device_fingerprint_hash, '')), '');
  v_media public.media_state := coalesce(media_state, 'audio');
  v_invite public.room_invites%rowtype;
  v_room public.rooms%rowtype;
  v_secret text;
  v_session public.guest_sessions%rowtype;
  v_existing public.room_participants%rowtype;
  v_now timestamptz := earth.utc_now();
begin
  if v_kind = 'visitor' then
    perform earth.raise('not_authenticated');
  end if;
  if v_kind <> 'guest' then
    perform earth.raise('forbidden');
  end if;
  -- spec §83: Guests get the reduced budget of 10/10min → 5/10min.
  perform earth.rate_limit_for_caller('guest_session_create', 10, 600);
  if not earth.flag('GUEST_ROOMS_ENABLED') then
    perform earth.raise('feature_disabled');
  end if;
  if token is null or token = '' then
    perform earth.raise('invite_invalid');
  end if;
  if v_name is null or length(v_name) > 40 then
    perform earth.raise('invalid_input', 'display_name must be 1 to 40 characters');
  end if;
  if v_fingerprint is not null and length(v_fingerprint) not between 8 and 128 then
    perform earth.raise('invalid_input', 'device_fingerprint_hash must be 8 to 128 characters');
  end if;

  v_invite := earth.assert_room_invite_usable(earth.sha256_hex(token));
  v_room := earth.assert_room(v_invite.room_id, true);
  if v_room.status = 'ended' then
    perform earth.raise('room_ended');
  end if;
  if v_room.guests_disabled then
    perform earth.raise('guests_disabled');
  end if;
  if v_fingerprint is not null and exists (
    select 1 from public.room_blocked_fingerprints bf
     where bf.room_id = v_room.id and bf.fingerprint_hash = v_fingerprint
  ) then
    perform earth.raise('blocked');
  end if;
  if exists (
    select 1 from public.guest_sessions gs
     where gs.room_id = v_room.id and gs.auth_user_id = v_uid and (gs.blocked or gs.removed_at is not null)
  ) then
    perform earth.raise('blocked');
  end if;

  v_secret := earth.random_token();

  -- One usable session per credential and room: re-entering rotates the secret and re-activates.
  select * into v_session
    from public.guest_sessions gs
   where gs.room_id = v_room.id and gs.auth_user_id = v_uid and gs.removed_at is null and gs.expires_at > v_now
   order by gs.created_at desc
   limit 1
     for update;
  if found then
    update public.guest_sessions gs
       set display_name = v_name,
           session_secret_hash = earth.sha256_hex(v_secret),
           device_fingerprint_hash = coalesce(v_fingerprint, gs.device_fingerprint_hash),
           room_invite_id = v_invite.id,
           expires_at = v_now + interval '24 hours'
     where gs.id = v_session.id
    returning * into v_session;
  else
    insert into public.guest_sessions
      (room_id, auth_user_id, room_invite_id, display_name, session_secret_hash, device_fingerprint_hash, created_at, expires_at)
    values
      (v_room.id, v_uid, v_invite.id, v_name, earth.sha256_hex(v_secret), v_fingerprint, v_now, v_now + interval '24 hours')
    returning * into v_session;
  end if;

  select * into v_existing
    from public.room_participants rp
   where rp.room_id = v_room.id and rp.guest_session_id = v_session.id and rp.status in ('invited', 'waiting', 'active')
   order by rp.joined_at desc
   limit 1;
  if found then
    update public.room_participants rp
       set status = 'active',
           media_state = v_media,
           role = case when v_media = 'watching' then 'viewer'::public.participant_role else 'participant'::public.participant_role end,
           audience_consent_level = greatest(rp.audience_consent_level, v_room.visibility),
           display_name_snapshot = v_name,
           joined_at = case when rp.status = 'active' then rp.joined_at else v_now end
     where rp.id = v_existing.id;
  else
    insert into public.room_participants
      (room_id, guest_session_id, role, media_state, status, audience_consent_level, consent_recorded_at,
       display_name_snapshot, invited_by_human_id, joined_at)
    values
      (v_room.id, v_session.id,
       case when v_media = 'watching' then 'viewer'::public.participant_role else 'participant'::public.participant_role end,
       v_media, 'active', v_room.visibility, v_now, v_name, v_invite.created_by_human_id, v_now);
  end if;

  update public.room_invites ri set use_count = ri.use_count + 1 where ri.id = v_invite.id;

  return jsonb_build_object(
    'guestSessionId', v_session.id,
    'roomId', v_room.id,
    'displayName', v_session.display_name,
    'expiresAt', to_jsonb(v_session.expires_at),
    'sessionSecret', v_secret
  );
end
$$;

create or replace function public.guest_session_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_uid uuid := auth.uid();
  v_sessions jsonb;
  v_rooms integer;
  v_humans integer;
  v_current jsonb;
begin
  if v_kind = 'visitor' then
    perform earth.raise('not_authenticated');
  end if;
  if v_kind <> 'guest' then
    perform earth.raise('guest_not_allowed');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'guestSessionId', gs.id,
           'roomId', gs.room_id,
           'displayName', gs.display_name,
           'expiresAt', to_jsonb(gs.expires_at),
           'removedAt', to_jsonb(gs.removed_at),
           'roomStatus', r.status,
           'createdAt', to_jsonb(gs.created_at)
         ) order by gs.created_at desc, gs.id), '[]'::jsonb)
    into v_sessions
    from public.guest_sessions gs
    join public.rooms r on r.id = gs.room_id
   where gs.auth_user_id = v_uid;

  select earth_sessions.current into v_current
    from (
      select jsonb_build_object(
               'guestSessionId', gs.id,
               'roomId', gs.room_id,
               'displayName', gs.display_name,
               'expiresAt', to_jsonb(gs.expires_at)
             ) as current
        from public.guest_sessions gs
        join public.rooms r on r.id = gs.room_id and r.status in ('starting', 'active')
       where gs.auth_user_id = v_uid and gs.removed_at is null and gs.expires_at > earth.utc_now()
       order by gs.created_at desc
       limit 1
    ) earth_sessions;

  -- "You've joined N rooms with M people": distinct rooms this credential joined, distinct Humans
  -- who were active in those rooms at the same time as the Guest.
  select count(distinct gs.room_id) into v_rooms
    from public.guest_sessions gs
    join public.room_participants rp on rp.guest_session_id = gs.id
   where gs.auth_user_id = v_uid;

  select count(distinct other.human_id) into v_humans
    from public.guest_sessions gs
    join public.room_participants mine on mine.guest_session_id = gs.id
    join public.room_participants other
      on other.room_id = mine.room_id
     and other.human_id is not null
     and other.status <> 'removed'
     and other.joined_at <= coalesce(mine.left_at, earth.utc_now())
     and coalesce(other.left_at, earth.utc_now()) >= mine.joined_at
   where gs.auth_user_id = v_uid;

  return jsonb_build_object(
    'sessions', v_sessions,
    'current', v_current,
    'roomsJoined', coalesce(v_rooms, 0),
    'humansMet', coalesce(v_humans, 0)
  );
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Media grant (ARCHITECTURE §10; spec §105)
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
    'canPublish', v_participant.media_state <> 'watching',
    'canSubscribe', true,
    'canPublishData', true,
    'ttlSeconds', 7200
  );
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Service: LiveKit reconciliation and the sweep (ARCHITECTURE §6 routes)
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
         or not exists (select 1 from public.guest_sessions gs where gs.id = v_participant.guest_session_id
                          and gs.removed_at is null and gs.expires_at > v_at)) then
      return jsonb_build_object('roomId', v_room.id, 'participantId', v_participant.id, 'event', v_event, 'applied', false, 'ignored', true, 'reason', 'guest_session_unusable');
    end if;
    update public.room_participants rp
       set status = 'active', left_at = null, joined_at = v_at
     where rp.id = v_participant.id;
    return jsonb_build_object('roomId', v_room.id, 'participantId', v_participant.id, 'event', v_event, 'applied', true, 'ignored', false, 'reason', null);
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

create or replace function public.rooms_sweep()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_now timestamptz := earth.utc_now();
  v_grace integer := coalesce(nullif(earth.setting('room_grace_seconds'), '')::integer, 120);
  v_room record;
  v_rooms_ended integer := 0;
  v_guests_expired integer := 0;
  v_invites_expired integer := 0;
  v_shares_revoked integer := 0;
  v_pointers integer := 0;
  v_pruned integer := 0;
begin
  if earth.current_role_kind() <> 'service' then
    perform earth.raise('forbidden');
  end if;

  -- Rooms with no active participants at all, and rooms whose last Human left more than the grace ago.
  for v_room in
    select r.id, r.active_participant_count, r.active_human_count
      from public.rooms r
     where r.status in ('starting', 'active')
       and (r.active_participant_count = 0
            or (r.active_human_count = 0 and r.humans_absent_since is not null
                and r.humans_absent_since <= v_now - make_interval(secs => v_grace)))
     order by r.created_at
       for update skip locked
  loop
    if earth.room_end_internal(
         v_room.id,
         case when v_room.active_participant_count = 0 then 'empty' else 'no_humans' end
       ) then
      v_rooms_ended := v_rooms_ended + 1;
    end if;
  end loop;

  -- Expired guest sessions: their participant rows leave.
  with expired as (
    update public.room_participants rp
       set status = 'left', left_at = v_now
      from public.guest_sessions gs
     where gs.id = rp.guest_session_id
       and gs.expires_at <= v_now
       and rp.status in ('invited', 'waiting', 'active')
    returning rp.id
  )
  select count(*) into v_guests_expired from expired;

  update public.room_invites ri set status = 'expired'
   where ri.status = 'active' and ri.expires_at <= v_now;
  get diagnostics v_invites_expired = row_count;

  -- Location shares land in 05xx; revoke expired ones once the table exists.
  if to_regclass('public.location_shares') is not null
     and exists (select 1 from information_schema.columns c
                  where c.table_schema = 'public' and c.table_name = 'location_shares'
                    and c.column_name in ('expires_at', 'revoked_at')
                 having count(*) = 2) then
    execute 'update public.location_shares ls set revoked_at = $1 where ls.revoked_at is null and ls.expires_at <= $1'
      using v_now;
    get diagnostics v_shares_revoked = row_count;
  end if;

  v_pointers := earth.clear_stale_active_room_pointers();
  v_pruned := earth.rate_limit_prune();

  return jsonb_build_object(
    'roomsEnded', v_rooms_ended,
    'guestSessionsExpired', v_guests_expired,
    'roomInvitesExpired', v_invites_expired,
    'locationSharesRevoked', v_shares_revoked,
    'activeRoomPointersCleared', v_pointers,
    'rateLimitsPruned', v_pruned,
    'sweptAt', to_jsonb(v_now)
  );
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Live discovery (SCREEN 13; ARCHITECTURE §6 GET /api/live, §9)
-- ---------------------------------------------------------------------------------------------------

-- Active rooms visible to the caller in a scope. Friends: rooms reached through the caller's social
-- graph (participant, group, friends / friends of friends of publishers). Neighborhood / city: public
-- Lives located in the area (`area_id` or the caller's context). World: world Lives. Only publishing
-- participants are listed (viewers never reveal presence). Ranking is done in the server tier.
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
           'contextTitle', earth.room_context_title(c.id, v_me),
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

-- ---------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------

revoke execute on function public.room_start(public.room_context_type, uuid, text) from public;
revoke execute on function public.room_get(uuid) from public;
revoke execute on function public.room_join(uuid, public.media_state, public.room_visibility) from public;
revoke execute on function public.room_invite_join(text, public.media_state, public.room_visibility) from public;
revoke execute on function public.room_set_media_state(uuid, public.media_state, public.room_visibility) from public;
revoke execute on function public.room_consent(uuid, public.room_visibility) from public;
revoke execute on function public.room_set_visibility(uuid, public.room_visibility, public.room_join_policy) from public;
revoke execute on function public.room_set_join_policy(uuid, public.room_join_policy) from public;
revoke execute on function public.room_set_guests_disabled(uuid, boolean) from public;
revoke execute on function public.room_admit(uuid, uuid) from public;
revoke execute on function public.room_leave(uuid) from public;
revoke execute on function public.room_end(uuid, text) from public;
revoke execute on function public.room_remove_participant(uuid, uuid, boolean) from public;
revoke execute on function public.room_invite_create(uuid, integer, public.room_join_policy) from public;
revoke execute on function public.room_invite_preview(text) from public;
revoke execute on function public.guest_session_create(text, text, text, public.media_state) from public;
revoke execute on function public.guest_session_get() from public;
revoke execute on function public.room_media_grant(uuid) from public;
revoke execute on function public.room_participant_sync(uuid, text, text, timestamptz) from public;
revoke execute on function public.rooms_sweep() from public;
revoke execute on function public.live_candidates(public.audience, uuid, integer) from public;

grant execute on function public.room_start(public.room_context_type, uuid, text) to anon, authenticated, service_role;
grant execute on function public.room_get(uuid) to anon, authenticated, service_role;
grant execute on function public.room_join(uuid, public.media_state, public.room_visibility) to anon, authenticated, service_role;
grant execute on function public.room_invite_join(text, public.media_state, public.room_visibility) to anon, authenticated, service_role;
grant execute on function public.room_set_media_state(uuid, public.media_state, public.room_visibility) to anon, authenticated, service_role;
grant execute on function public.room_consent(uuid, public.room_visibility) to anon, authenticated, service_role;
grant execute on function public.room_set_visibility(uuid, public.room_visibility, public.room_join_policy) to anon, authenticated, service_role;
grant execute on function public.room_set_join_policy(uuid, public.room_join_policy) to anon, authenticated, service_role;
grant execute on function public.room_set_guests_disabled(uuid, boolean) to anon, authenticated, service_role;
grant execute on function public.room_admit(uuid, uuid) to anon, authenticated, service_role;
grant execute on function public.room_leave(uuid) to anon, authenticated, service_role;
grant execute on function public.room_end(uuid, text) to anon, authenticated, service_role;
grant execute on function public.room_remove_participant(uuid, uuid, boolean) to anon, authenticated, service_role;
grant execute on function public.room_invite_create(uuid, integer, public.room_join_policy) to anon, authenticated, service_role;
grant execute on function public.room_invite_preview(text) to anon, authenticated, service_role;
grant execute on function public.guest_session_create(text, text, text, public.media_state) to anon, authenticated, service_role;
grant execute on function public.guest_session_get() to anon, authenticated, service_role;
grant execute on function public.room_media_grant(uuid) to anon, authenticated, service_role;
-- Service-only RPCs: the role check inside is authoritative; the grant keeps the surface explicit.
grant execute on function public.room_participant_sync(uuid, text, text, timestamptz) to service_role;
grant execute on function public.rooms_sweep() to service_role;
grant execute on function public.live_candidates(public.audience, uuid, integer) to anon, authenticated, service_role;

-- Internals that mutate state stay owner/service only.
revoke execute on function earth.room_join_human(uuid, uuid, public.media_state, public.room_visibility, boolean, public.room_join_policy, uuid) from public, anon, authenticated;
revoke execute on function earth.assert_room(uuid, boolean) from public, anon, authenticated;
revoke execute on function earth.assert_room_moderator(uuid, uuid) from public, anon, authenticated;
