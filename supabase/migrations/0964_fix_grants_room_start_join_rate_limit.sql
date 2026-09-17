-- 0964 — grants review: `room_start` on a context whose room is already live is a join and is
-- rate limited as one (spec §83; DB_API §3 `room_start` "returns existing active room (join as
-- `watching` participant if not already)"; 0730 inventory; ARCHITECTURE §5 "apply rate limits").
--
-- 0330 charged `room_start` (20/h, spec §83 Live creation) only on the creation path. When the
-- group's or the direct conversation's room was already live, the RPC seated the caller through
-- `earth.room_join_human` and returned before any `earth.rate_limit_for_caller` call: a member
-- could call `room_start(group, <id>)` without limit, each call rewriting their `room_participants`
-- row (`joined_at`, consent, role), running `earth.room_transfer_moderator` and rendering
-- `earth.room_json` — a mutating path with no rate limit. `supabase/tests/src/verify/grants.test.ts`
-- reproduces it: with every window of the caller exhausted, `room_start` on the live group room
-- still succeeded and wrote `room_participants`.
--
-- The join path now spends the `room_join` window (120/h, the same literal 0730 lists for
-- `room_join`) before `earth.room_join_human`, exactly like `room_join` itself; the creation path
-- keeps `room_start` 20/h. The body is the 0330 definition with that one line added; grants are
-- restated (`create or replace` keeps them).

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
      -- A join, not a creation: it spends the join window (0730 `room_join` 120/h), so a member
      -- cannot re-seat themselves without limit while the context's room is live.
      perform earth.rate_limit_for_caller('room_join', 120, 3600);
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

-- Grants unchanged from 0330 (restated: client profile, never PUBLIC).
revoke execute on function public.room_start(public.room_context_type, uuid, text) from public;
grant execute on function public.room_start(public.room_context_type, uuid, text) to anon, authenticated, service_role;
