-- 0970 — fix (audience): a private group names itself only to its own members in Live
-- notifications, never to the friends of its publishers (spec §128 "Private group/chat content
-- never appears in World", §60 participant-aware naming, §86 notification copy; DB_API §3
-- `notify_live`; ARCHITECTURE §11).
--
-- 0998 closed this leak for discovery (`live_candidates` → Live Home, the feed's live payload and
-- the map pins) and assumed notifications were already safe. They were not. `earth.notify_live`
-- (0310:806) builds its recipient set as `members UNION friends-of-publishers` the moment a room's
-- visibility reaches `friends` (spec §58 "Open up -> Friends"), but chose the notification type,
-- title and payload from the room's context alone. So a Human who is not in the group received
-- `group_live` titled "<private group name> is live", with `payload.groupName` and
-- `payload.contextTitle` carrying that name — in the notification list and, through
-- `notificationCopyFromPayload` / `pushMessagesFor`, on their phone.
--
-- The copy branch is now per recipient: members still get "Weekend Crew is live" +
-- "Xavier, Maya + 2" and `contextTitle: 'Weekend Crew'`; a non-member falls through to the
-- existing `friend_live` / `multi_live` branches, which already name the room with
-- `earth.live_title(v_names, v_total)` ordered for that recipient (friends first), and their
-- `contextTitle` is null — the same shape 0961 gave direct rooms and 0998 gave group discovery.
--
-- Recipients, cooldown/dedupe (spec §87 `shouldNotifyLive`), ordering, blocks and the signature
-- and grants of `earth.notify_live` are those of 0310, unchanged. Only the copy changes.

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
  v_context_name text;
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

    -- 0970: a private group names itself to its own members only (spec §128). Everyone else who
    -- reaches this room through `friends` is a friend of a publisher, not of the group: they get
    -- the participant-aware copy, exactly as 0961/0998 made discovery behave.
    v_context_name := case
      when v_room.context_type = 'group'
       and nullif(btrim(coalesce(v_group_name, '')), '') is not null
       and earth.is_group_member(v_room.context_id, v_recipient)
      then v_group_name
    end;

    if v_context_name is not null then
      v_type := 'group_live';
      v_title := v_context_name || ' is live';
      v_payload := jsonb_build_object('groupName', v_context_name, 'names', to_jsonb(v_names), 'total', v_total);
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
      'contextTitle', v_context_name,
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

-- 0310 grant posture, restated (the function is internal: `notify_live` is called by the room RPCs).
revoke execute on function earth.notify_live(uuid, uuid) from public, anon, authenticated;
