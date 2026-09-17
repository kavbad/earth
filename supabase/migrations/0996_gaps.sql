-- 0996 — product gaps reported by the client agents (DB_API §1, §2, §3, §4, §5, §6; spec §17, §20,
-- §29, §39, §40, §57–§59, §80, §86, §128). Every function is `create or replace` on the 0180 / 0185 /
-- 0310 / 0530 / 0600 / 0951 definitions with identical grants, except `identity_update`, whose
-- signature grows a `handle` argument (the old signature is dropped so `public` keeps one function
-- per name). Reproduced by supabase/tests/src/verify/gaps.test.ts.
--
--   1. `posts_by_author(handle, cursor, limit)` — an author's root posts the caller may see
--      (`earth.can_view_post`), newest first, keyset on `(created_at, id)`; the profile screen no
--      longer reads the `posts` table directly. Visitors reach world posts of public profiles only
--      (`earth.identity_visible_to` + `PUBLIC_WORLD_ENABLED`).
--   2. `identity_update(..., handle)` — Settings can change the handle with the claim rules
--      (`handle_invalid` / `handle_taken`, case-insensitive uniqueness).
--   3. `NotificationDto.actorHandle` — the actor's *current* handle, resolved when the row is read
--      (`earth.notification_json`), never stored: handles change (2) and a deleted Human's handle is
--      freed (7), so a stored handle could route a tap to the wrong profile. Every type with a
--      Human actor carries it (friend_request, friend_accepted, follow, group_invitation, ...).
--   4. `ConversationSummaryDto.myPrefs` — the caller's `{muteState, notificationLevel,
--      lastReadMessageId}` in `earth.conversation_summary_json`, so `conversation_get` (and the
--      list) stop guessing.
--   5. `RoomDto.canJoinAudio / canJoinCamera / joinReason` — computed by `earth.room_join_check`,
--      the very check `earth.room_join_human` now runs before seating anyone (join policy, removed
--      seats, ended rooms, blocks; the consent gate only when a consent level is given).
--   6. `location_shares_mine()` — the caller's own live shares (`LocationShareDto[]`).
--   7. `human_delete_request()` — deletes the caller's Human (spec §80: the credential may claim
--      again through the normal claim, which creates a *new* Human; nothing is restored).

-- ---------------------------------------------------------------------------------------------------
-- 1. posts_by_author
-- ---------------------------------------------------------------------------------------------------

-- Keyset cursor of a post: `<createdAt ISO>,<id>` (same shape as earth.notification_cursor).
create or replace function earth.post_cursor(p_created_at timestamptz, p_id uuid)
returns text
language sql
immutable
strict
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select (to_jsonb(p_created_at) #>> '{}') || ',' || p_id::text
$$;

-- `{posts: PostViewDto[], nextCursor}`: the author's root posts (`parent_post_id is null`,
-- `status = 'active'`) that the caller may see, minus the caller's hides, newest first. The author
-- must be visible to the caller (`not_visible` otherwise — profiles and posts share one rule);
-- `cursor` is a previous page's `nextCursor` of the same author (`invalid_input` otherwise);
-- `limit` is clamped to 1..100.
create or replace function public.posts_by_author(handle text, cursor text default null, "limit" integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_viewer uuid := earth.viewer_human();
  v_self uuid := earth.current_human_id();
  v_handle text := earth.normalize_handle(handle);
  v_author uuid;
  v_limit integer := least(greatest(coalesce("limit", 20), 1), 100);
  v_cursor text := cursor;
  v_after_created timestamptz;
  v_after_id uuid;
  v_ids uuid[];
  v_page uuid[];
  v_rows jsonb;
  v_next text;
begin
  select p.human_id into v_author
    from public.public_identities p
   where lower(p.handle) = v_handle;
  if v_author is null
     or not ((v_self is not null and v_author = v_self) or earth.identity_visible_to(v_author, v_viewer)) then
    perform earth.raise('not_visible');
  end if;

  if v_cursor is not null then
    if position(',' in v_cursor) = 0 then
      perform earth.raise('invalid_input', 'cursor must be <createdAt>,<id>');
    end if;
    begin
      v_after_created := split_part(v_cursor, ',', 1)::timestamptz;
      v_after_id := split_part(v_cursor, ',', 2)::uuid;
    exception
      when others then
        perform earth.raise('invalid_input', 'cursor must be <createdAt>,<id>');
    end;
    if not exists (
      select 1 from public.posts p
       where p.id = v_after_id and p.author_human_id = v_author and p.created_at = v_after_created
    ) then
      perform earth.raise('invalid_input', 'cursor does not point at a post of this author');
    end if;
  end if;

  -- One row more than the page tells whether a next page exists.
  select coalesce(array_agg(p.id order by p.created_at desc, p.id desc), '{}'::uuid[])
    into v_ids
    from (
      select p.id, p.created_at
        from public.posts p
       where p.author_human_id = v_author
         and p.parent_post_id is null
         and p.status = 'active'
         and (v_after_id is null or (p.created_at, p.id) < (v_after_created, v_after_id))
         and earth.can_view_post(p.id, v_viewer)
         and not earth.post_hidden_by(p.id, v_viewer)
       order by p.created_at desc, p.id desc
       limit v_limit + 1
    ) p;
  v_page := v_ids[1:v_limit];

  select coalesce(jsonb_agg(earth.post_json(ids.id, v_viewer) order by ids.ordinality), '[]'::jsonb)
    into v_rows
    from unnest(v_page) with ordinality as ids(id, ordinality);

  if coalesce(array_length(v_ids, 1), 0) > v_limit then
    select earth.post_cursor(p.created_at, p.id) into v_next
      from public.posts p
     where p.id = v_page[v_limit];
  end if;

  return jsonb_build_object('posts', v_rows, 'nextCursor', v_next);
end
$$;

revoke execute on function public.posts_by_author(text, text, integer) from public;
grant execute on function public.posts_by_author(text, text, integer) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------
-- 2. identity_update with a handle
-- ---------------------------------------------------------------------------------------------------

drop function if exists public.identity_update(text, text, uuid, public.profile_visibility, boolean, uuid);

-- Same as 0180 plus `handle`: normalized like claim_set_identity (case, whitespace, leading `@`),
-- `handle_invalid` unless it matches the handle rule, `handle_taken` when another Human holds it
-- (case-insensitively; the unique index on `lower(handle)` closes the race). The caller's own
-- handle is a no-op. A change is audited.
create or replace function public.identity_update(
  display_name text default null,
  bio text default null,
  avatar_media_id uuid default null,
  profile_visibility public.profile_visibility default null,
  public_city_visibility boolean default null,
  home_city_area_id uuid default null,
  handle text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_human uuid := earth.assert_human();
  v_name text := case when display_name is null then null else btrim(display_name) end;
  v_bio text := case when bio is null then null else nullif(btrim(bio), '') end;
  v_bio_given boolean := bio is not null;
  v_avatar uuid := avatar_media_id;
  v_visibility public.profile_visibility := profile_visibility;
  v_city_visible boolean := public_city_visibility;
  v_home uuid := home_city_area_id;
  v_handle text := case when handle is null then null else earth.normalize_handle(handle) end;
  v_previous_handle text;
  v_updated integer := 0;
begin
  perform earth.rate_limit_for_caller('identity_update', 60, 3600);

  if v_name is not null and (length(v_name) < 1 or length(v_name) > 40) then
    perform earth.raise('invalid_input', 'display_name must be 1–40 characters');
  end if;
  if v_bio is not null and length(v_bio) > 280 then
    perform earth.raise('invalid_input', 'bio must be at most 280 characters');
  end if;
  perform earth.assert_avatar_media(v_avatar, v_human);
  if v_home is not null then
    if not exists (select 1 from public.areas a where a.id = v_home) then
      perform earth.raise('area_not_found');
    end if;
    if not exists (select 1 from public.areas a where a.id = v_home and a.type = 'city') then
      perform earth.raise('invalid_input', 'home_city_area_id must be a city');
    end if;
  end if;
  if v_handle is not null then
    if not earth.is_valid_handle(v_handle) then
      perform earth.raise('handle_invalid');
    end if;
    if earth.handle_taken(v_handle, v_human) then
      perform earth.raise('handle_taken');
    end if;
  end if;

  select p.handle into v_previous_handle from public.public_identities p where p.human_id = v_human;

  begin
    update public.public_identities p
       set display_name = coalesce(v_name, p.display_name),
           bio = case when v_bio_given then v_bio else p.bio end,
           avatar_media_id = coalesce(v_avatar, p.avatar_media_id),
           profile_visibility = coalesce(v_visibility, p.profile_visibility),
           public_city_visibility = coalesce(v_city_visible, p.public_city_visibility),
           home_city_area_id = coalesce(v_home, p.home_city_area_id),
           handle = coalesce(v_handle, p.handle)
     where p.human_id = v_human;
    get diagnostics v_updated = row_count;
  exception
    when unique_violation then
      perform earth.raise('handle_taken');
  end;
  if v_updated = 0 then
    perform earth.raise('claim_identity_missing');
  end if;

  if v_handle is not null and v_handle is distinct from v_previous_handle then
    perform earth.audit(
      'identity_handle_change', 'human', v_human,
      jsonb_build_object('from', v_previous_handle, 'to', v_handle)
    );
  end if;

  if v_home is not null then
    insert into public.human_context (human_id, home_city_id) values (v_human, v_home)
    on conflict on constraint human_context_pkey do update set home_city_id = excluded.home_city_id;
  end if;

  return earth.identity_json(v_human);
end
$$;

revoke execute on function public.identity_update(text, text, uuid, public.profile_visibility, boolean, uuid, text) from public;
grant execute on function public.identity_update(text, text, uuid, public.profile_visibility, boolean, uuid, text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------
-- 3. NotificationDto.actorHandle (0600 earth.notification_json)
-- ---------------------------------------------------------------------------------------------------

-- The actor's current handle while the actor is an active Human, else null (a deleted or
-- suspended actor has no profile to route to). Resolved at read time, never stored.
create or replace function earth.notification_actor_handle(p_actor uuid)
returns text
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select p.handle
    from public.public_identities p
    join public.humans h on h.id = p.human_id
   where p.human_id = p_actor
     and h.status = 'active'
$$;

create or replace function earth.notification_json(p_row public.notifications)
returns jsonb
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
    'id', p_row.id,
    'type', p_row.type,
    'priority', p_row.priority,
    'actorHumanId', p_row.actor_human_id,
    'actorHandle', earth.notification_actor_handle(p_row.actor_human_id),
    'objectType', p_row.object_type,
    'objectId', p_row.object_id,
    'payload', p_row.payload,
    'readAt', to_jsonb(p_row.read_at),
    'createdAt', to_jsonb(p_row.created_at)
  ) || earth.notification_copy_json(p_row.type, p_row.payload)
$$;

-- ---------------------------------------------------------------------------------------------------
-- 4. ConversationSummaryDto.myPrefs (0185 earth.conversation_summary_json)
-- ---------------------------------------------------------------------------------------------------

-- The viewer's own `conversation_members` preferences, or null when the viewer is not a member.
create or replace function earth.conversation_my_prefs_json(p_conversation_id uuid, p_viewer uuid)
returns jsonb
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
           'muteState', cm.mute_state,
           'notificationLevel', cm.notification_level,
           'lastReadMessageId', cm.last_read_message_id
         )
    from public.conversation_members cm
   where cm.conversation_id = p_conversation_id
     and cm.human_id = p_viewer
     and p_viewer is not null
$$;

create or replace function earth.conversation_summary_json(p_conversation_id uuid, p_viewer uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_conv public.conversations%rowtype;
  v_group public.groups%rowtype;
  v_names text[];
  v_avatars jsonb;
  v_title text;
  v_unread integer;
  v_group_avatar text;
begin
  select * into v_conv from public.conversations c where c.id = p_conversation_id;
  if not found then
    return null;
  end if;
  if v_conv.group_id is not null then
    select * into v_group from public.groups g where g.id = v_conv.group_id;
  end if;

  select coalesce(array_agg(p.display_name order by cm.joined_at, p.display_name, cm.human_id), '{}'::text[]),
         coalesce(jsonb_agg(earth.public_media_url(p.avatar_media_id) order by cm.joined_at, p.display_name, cm.human_id)
                  filter (where earth.public_media_url(p.avatar_media_id) is not null), '[]'::jsonb)
    into v_names, v_avatars
    from public.conversation_members cm
    join public.humans h on h.id = cm.human_id and h.status = 'active'
    join public.public_identities p on p.human_id = cm.human_id
   where cm.conversation_id = v_conv.id
     and cm.human_id is distinct from p_viewer;

  v_group_avatar := case when v_group.id is null then null else earth.public_media_url(v_group.avatar_media_id) end;
  if v_group.name is not null then
    v_title := v_group.name;
  else
    v_title := earth.format_name_list(v_names);
    if v_title = '' then
      v_title := case when v_conv.type = 'direct' then 'Earth member' else 'New group' end;
    end if;
  end if;
  if v_group_avatar is not null then
    v_avatars := jsonb_build_array(v_group_avatar);
  end if;

  select cm.unread_count into v_unread
    from public.conversation_members cm
   where cm.conversation_id = v_conv.id and cm.human_id = p_viewer;

  return jsonb_build_object(
    'id', v_conv.id,
    'type', v_conv.type,
    'groupId', v_conv.group_id,
    'title', v_title,
    'avatarUrls', (select coalesce(jsonb_agg(a) , '[]'::jsonb) from (select a from jsonb_array_elements(v_avatars) a limit 4) s),
    'lastMessage', earth.last_message_json(v_conv.id),
    'unreadCount', coalesce(v_unread, 0),
    'activeRoom', earth.active_room_ref_json(v_conv.active_room_id),
    'lastMessageAt', to_jsonb(v_conv.last_message_at),
    'myPrefs', earth.conversation_my_prefs_json(v_conv.id, p_viewer)
  );
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- 5. Join affordances: earth.room_join_check, shared by room_join_human and room_json
-- ---------------------------------------------------------------------------------------------------

-- What `p_human` is to the room for the join policy (0951 earth.room_join_human, verbatim):
-- `invited` — an unexpired link, the initiator, an explicit invite row, or a seat (live or left) that
-- was admitted or moderates; `member` — group room and current group membership; `friend` — direct
-- friend of a publishing participant; `fof` — friend, or friend of a friend, of one.
create or replace function earth.room_join_relation(p_room_id uuid, p_human uuid, p_has_link boolean default false)
returns table (invited boolean, member boolean, friend boolean, fof boolean)
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_existing public.room_participants%rowtype;
  v_friend boolean;
begin
  select * into v_room from public.rooms r where r.id = p_room_id;
  if not found or p_human is null then
    return query select false, false, false, false;
    return;
  end if;
  select * into v_existing
    from public.room_participants rp
   where rp.room_id = v_room.id and rp.human_id = p_human and rp.status in ('invited', 'waiting', 'active')
   order by rp.joined_at desc
   limit 1;
  v_friend := earth.room_friend_of_publisher(v_room.id, p_human);
  return query select
    (coalesce(p_has_link, false)
      or v_room.initiated_by_human_id = p_human
      or (v_existing.id is not null and (
            v_existing.status = 'invited'
            or v_existing.publish_admitted_at is not null
            or v_existing.role in ('initiator', 'moderator')))
      or exists (
        select 1 from public.room_participants rp
         where rp.room_id = v_room.id and rp.human_id = p_human and rp.status = 'left'
           and (rp.publish_admitted_at is not null or rp.role in ('initiator', 'moderator'))
      )),
    (v_room.context_type = 'group' and earth.is_group_member(v_room.context_id, p_human)),
    v_friend,
    (v_friend or earth.room_friend_of_friend_of_publisher(v_room.id, p_human));
end
$$;

-- The machine code `room_join` would raise for `p_viewer` entering with `p_media`, or null when the
-- join would go through (possibly as a `waiting` seat under `request`): `not_authenticated` (no
-- Human), `room_not_found` (not visible, blocks included), `room_ended`, `join_not_allowed`
-- (removed seat, or the join policy refuses a publisher), `consent_required` (only when
-- `p_consent` is given: audio/camera at the room's visibility needs consent at least that wide,
-- counting a live seat's recorded consent). Viewers (`watching`) only need visibility. Mirror of
-- canJoinWithMedia in packages/domain/src/rooms/state.ts.
create or replace function earth.room_join_check(
  p_room_id uuid,
  p_viewer uuid,
  p_media public.media_state,
  p_consent public.room_visibility default null,
  p_has_link boolean default false,
  p_policy_override public.room_join_policy default null
)
returns text
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_media public.media_state := coalesce(p_media, 'watching');
  v_rel record;
  v_policy public.room_join_policy;
  v_seat_consent public.room_visibility;
begin
  if p_room_id is null then
    return 'room_not_found';
  end if;
  select * into v_room from public.rooms r where r.id = p_room_id;
  if not found then
    return 'room_not_found';
  end if;
  if p_viewer is null then
    return 'not_authenticated';
  end if;
  if not (earth.room_visible_to(v_room.id, p_viewer)
          or (coalesce(p_has_link, false) and not earth.room_blocked_for(v_room.id, p_viewer))) then
    return 'room_not_found';
  end if;
  if v_room.status = 'ended' then
    return 'room_ended';
  end if;
  if exists (
    select 1 from public.room_participants rp
     where rp.room_id = v_room.id and rp.human_id = p_viewer and rp.status = 'removed'
  ) then
    return 'join_not_allowed';
  end if;
  if v_media = 'watching' then
    return null;
  end if;

  select * into v_rel from earth.room_join_relation(v_room.id, p_viewer, p_has_link);
  v_policy := coalesce(p_policy_override, v_room.join_policy);
  case v_policy
    when 'invited_only' then
      if not v_rel.invited then return 'join_not_allowed'; end if;
    when 'group' then
      if not (v_rel.invited or v_rel.member) then return 'join_not_allowed'; end if;
    when 'friends' then
      if not (v_rel.invited or v_rel.member or v_rel.friend) then return 'join_not_allowed'; end if;
    when 'friends_of_friends' then
      if not (v_rel.invited or v_rel.member or v_rel.fof) then return 'join_not_allowed'; end if;
    when 'request' then
      null; -- a `waiting` seat unless invited or a member
    when 'anyone_with_link' then
      if not v_rel.invited then return 'join_not_allowed'; end if;
    when 'anyone' then
      null;
  end case;

  if p_consent is not null then
    select rp.audience_consent_level into v_seat_consent
      from public.room_participants rp
     where rp.room_id = v_room.id and rp.human_id = p_viewer and rp.status in ('invited', 'waiting', 'active')
     order by rp.joined_at desc
     limit 1;
    if greatest(coalesce(v_seat_consent, 'invited'), p_consent) < v_room.visibility then
      return 'consent_required';
    end if;
  end if;
  return null;
end
$$;

-- 0951 earth.room_join_human with its checks factored into earth.room_join_check (same codes, same
-- order, same seats): the RPC and the affordance can no longer disagree.
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
  v_code text;
  v_existing public.room_participants%rowtype;
  v_rel record;
  v_policy public.room_join_policy;
  v_status public.participant_status := 'active';
  v_role public.participant_role;
  v_consent public.room_visibility;
  v_was_publishing boolean := false;
  v_now timestamptz := earth.utc_now();
begin
  v_code := earth.room_join_check(v_room.id, p_human, v_media, coalesce(p_consent, 'invited'), p_has_link, p_policy_override);
  if v_code is not null then
    perform earth.raise(v_code);
  end if;

  select * into v_existing
    from public.room_participants rp
   where rp.room_id = v_room.id and rp.human_id = p_human and rp.status in ('invited', 'waiting', 'active')
   order by rp.joined_at desc
   limit 1;
  v_was_publishing := found and v_existing.status = 'active' and v_existing.media_state <> 'watching';

  select * into v_rel from earth.room_join_relation(v_room.id, p_human, p_has_link);
  v_policy := coalesce(p_policy_override, v_room.join_policy);
  if v_media <> 'watching' and v_policy = 'request' and not (v_rel.invited or v_rel.member) then
    v_status := 'waiting';
  end if;
  v_consent := greatest(coalesce(v_existing.audience_consent_level, 'invited'), coalesce(p_consent, 'invited'));

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

-- 0310 earth.room_json plus the viewer's join affordances: `canJoinAudio` / `canJoinCamera` are
-- `earth.room_join_check` without the consent gate (the consent sheet is the client's next step;
-- `myParticipant.audienceConsentLevel` says whether it is needed) and `joinReason` the code it
-- would raise, or null. A Guest may re-enter their room unless it ended, guests are disabled or
-- GUEST_ROOMS_ENABLED is off; a visitor gets `not_authenticated`.
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
    'contextTitle', earth.room_context_title(v_room.id, p_viewer),
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

-- ---------------------------------------------------------------------------------------------------
-- 6. location_shares_mine
-- ---------------------------------------------------------------------------------------------------

-- The caller's own live shares (`LocationShareDto[]`, soonest to expire last): not revoked, not
-- expired. Positions are never returned — the sharer's device has them; recipients read
-- `location_shares_visible()`.
create or replace function public.location_shares_mine()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_now timestamptz := earth.utc_now();
begin
  return coalesce((
    select jsonb_agg(earth.location_share_json(ls) order by ls.expires_at desc, ls.id)
      from public.location_shares ls
     where ls.human_id = v_me
       and ls.revoked_at is null
       and ls.expires_at > v_now
  ), '[]'::jsonb);
end
$$;

revoke execute on function public.location_shares_mine() from public;
grant execute on function public.location_shares_mine() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------------
-- 7. human_delete_request
-- ---------------------------------------------------------------------------------------------------

-- Deletes the caller's Human in one transaction and returns `{humanId, authUserId, deletedAt}`
-- so the server tier (`POST /api/account/delete`) can delete the credential through the Supabase
-- admin API afterwards. The Human row stays (audit, foreign keys, "a deleted Human is invisible
-- everywhere"): `status = 'deleted'`, `deleted_at`, `auth_user_id = null` — so the same credential
-- may claim again through the normal claim flow, which creates a *new* pending Human (spec §80:
-- recovery never restores a deleted Human by default) — and every `auth_identities` row revoked.
-- Live seats are left (rooms with no other active Human end now, reason `human_deleted`),
-- location shares revoked, presence / context / push tokens dropped, relationships and blocks
-- both ways removed, group memberships left (ownership handed on like group_leave; an empty group
-- archives), conversation memberships removed, the public identity anonymized (display name
-- `Deleted`, the handle freed by suffixing, no bio / avatar / city, `hidden`) and the caller's
-- notifications deleted. Audited before the credential link is cut. Active Humans only (the gate
-- runs before the rate-limit window: a refused caller writes nothing).
create or replace function public.human_delete_request()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_uid uuid := auth.uid();
  v_now timestamptz := earth.utc_now();
  v_room record;
  v_membership record;
  v_new_owner uuid;
  v_handle text;
  v_new_handle text;
  v_display_name text;
begin
  perform earth.rate_limit_for_caller('human_delete', 5, 3600);
  perform earth.audit('human_delete_request', 'human', v_me, jsonb_build_object('authUserId', v_uid));

  select p.handle, p.display_name into v_handle, v_display_name
    from public.public_identities p
   where p.human_id = v_me;

  -- Rooms: every live seat is left; a room with no other active Human ends now.
  for v_room in
    select distinct rp.room_id
      from public.room_participants rp
      join public.rooms r on r.id = rp.room_id and r.status in ('starting', 'active')
     where rp.human_id = v_me and rp.status in ('invited', 'waiting', 'active')
  loop
    update public.room_participants rp
       set status = 'left', left_at = v_now
     where rp.room_id = v_room.room_id and rp.human_id = v_me and rp.status in ('invited', 'waiting', 'active');
    if exists (
      select 1 from public.room_participants rp
       where rp.room_id = v_room.room_id and rp.status = 'active' and rp.human_id is not null
    ) then
      perform earth.room_transfer_moderator(v_room.room_id);
      perform earth.room_evaluate_pending_visibility(v_room.room_id);
    else
      perform earth.room_end_internal(v_room.room_id, 'human_deleted');
    end if;
  end loop;

  -- Location, presence, context, devices.
  update public.location_shares ls set revoked_at = v_now where ls.human_id = v_me and ls.revoked_at is null;
  delete from public.human_presence hp where hp.human_id = v_me;
  delete from public.human_context hc where hc.human_id = v_me;
  delete from public.push_tokens pt where pt.human_id = v_me;

  -- Social graph: every edge and block, both ways.
  delete from public.relationships r where r.source_human_id = v_me or r.target_human_id = v_me;
  delete from public.blocks b where b.blocker_human_id = v_me or b.blocked_human_id = v_me;

  -- Groups: leave like group_leave (system line, ownership transfer, archive when empty).
  for v_membership in
    select gm.group_id, gm.role, c.id as conversation_id
      from public.group_members gm
      join public.groups g on g.id = gm.group_id
      left join public.conversations c on c.group_id = gm.group_id
     where gm.human_id = v_me and gm.status = 'active'
  loop
    if v_membership.conversation_id is not null then
      perform earth.system_message(
        v_membership.conversation_id,
        coalesce(v_display_name, 'Someone') || ' left',
        jsonb_build_object('kind', 'member_left', 'actorHumanId', v_me),
        v_me
      );
    end if;
    update public.group_members gm
       set status = 'left', left_at = v_now, role = 'member'
     where gm.group_id = v_membership.group_id and gm.human_id = v_me;
    if v_membership.role = 'owner' then
      select gm.human_id into v_new_owner
        from public.group_members gm
       where gm.group_id = v_membership.group_id and gm.status = 'active'
       order by (gm.role = 'moderator') desc, gm.joined_at, gm.human_id
       limit 1;
      if v_new_owner is not null then
        update public.group_members gm set role = 'owner'
         where gm.group_id = v_membership.group_id and gm.human_id = v_new_owner;
      end if;
    end if;
    if not exists (
      select 1 from public.group_members gm where gm.group_id = v_membership.group_id and gm.status = 'active'
    ) then
      update public.groups g set status = 'archived' where g.id = v_membership.group_id;
    end if;
  end loop;
  delete from public.conversation_members cm where cm.human_id = v_me;

  -- Notifications addressed to the Human.
  delete from public.notifications n where n.recipient_human_id = v_me;
  delete from public.notification_cooldowns nc where nc.recipient_human_id = v_me;

  -- Identity: anonymized; the handle is freed by suffixing (`<handle>_<7 hex>`, still a handle).
  if v_handle is not null then
    loop
      v_new_handle := left(v_handle, 16) || '_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 7);
      exit when not earth.handle_taken(v_new_handle, v_me);
    end loop;
    update public.public_identities p
       set display_name = 'Deleted',
           handle = v_new_handle,
           bio = null,
           avatar_media_id = null,
           home_city_area_id = null,
           public_city_visibility = false,
           profile_visibility = 'hidden'
     where p.human_id = v_me;
  end if;

  -- Credential: every method revoked, the Human unlinked, the row marked deleted.
  update public.auth_identities ai set revoked_at = v_now where ai.human_id = v_me and ai.revoked_at is null;
  update public.humans h
     set status = 'deleted',
         deleted_at = v_now,
         auth_user_id = null,
         claim_invite_token_hash = null
   where h.id = v_me;

  return jsonb_build_object('humanId', v_me, 'authUserId', v_uid, 'deletedAt', to_jsonb(v_now));
end
$$;

revoke execute on function public.human_delete_request() from public;
grant execute on function public.human_delete_request() to anon, authenticated, service_role;
