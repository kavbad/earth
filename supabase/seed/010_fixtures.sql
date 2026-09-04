-- 010_fixtures.sql — development fixtures (spec §117 "Seed environment"; DB_API §10; ARCHITECTURE §15).
--
-- Eight fixture Humans (Xavier, Maya, Kavon, Sarah, Ben, Chris, Alex, Sam) with fixed credentials
-- (`<name>@fixtures.earth.local`, fixed auth.users ids), verified mock Human Passes, San Francisco
-- context (North Beach / Mission), friendships, follows, two groups ("Weekend Crew", "College") with
-- three days of chat, one direct conversation, known invite tokens, posts in every audience with a
-- reply thread, one ended Weekend Crew Live and one ended standalone Live with a Guest session, and a
-- few North Beach / Mission places. Every Human carries `humans.is_fixture = true`; the visitor-facing
-- surfaces hide fixtures when `app_settings.environment = 'production'` (DB_API §10) and this file
-- refuses to run there at all. Feature flags are never touched.
--
-- Everything a client could do goes through the public RPCs under caller impersonation
-- (`request.jwt.claims` = the fixture's credential, `earth.now` = the moment it "happened"), so the
-- same invariants hold as for real traffic: memberships come from `group_invite_join` with the
-- documented tokens, rooms from `room_start` / `room_join` / `room_set_visibility` / `room_consent` /
-- `room_end`, the Guest from `guest_session_create`, posts from `post_create`, reactions from the
-- reaction RPCs, friendships from `friend_request_send`. Chat history is written as
-- `message_send`-equivalent rows (client ids, insert trigger) because `messages.created_at` is the
-- transaction time and the history must spread over three days.
--
-- Idempotent: the fixture-owned rows are deleted and recreated on every run (Human ids are fixed,
-- auth rows are upserted so a developer's GoTrue session as a fixture survives a re-seed). Known
-- invite tokens: `weekend-crew-dev-token`, `college-dev-token` (stored as earth.sha256_hex).
-- Inventory and login instructions: supabase/seed/README.md. Never applied in production.

do $guard$
begin
  if coalesce(earth.setting('environment'), '') = 'production' then
    raise exception 'supabase/seed/010_fixtures.sql refused: app_settings.environment = production (fixture Humans are never created in production)';
  end if;
end
$guard$;

-- ---------------------------------------------------------------------------------------------------
-- Session-local helpers (dropped at the end of this file)
-- ---------------------------------------------------------------------------------------------------

-- Impersonates a credential the way PostgREST does: the RPCs read request.jwt.claims through
-- auth.uid() / earth.jwt_claims(). `null` returns to the service (no JWT).
create or replace function pg_temp.seed_as(p_uid uuid, p_anonymous boolean default false)
returns void
language plpgsql
as $$
begin
  perform set_config(
    'request.jwt.claims',
    case
      when p_uid is null then ''
      else jsonb_build_object(
             'role', 'authenticated', 'aud', 'authenticated', 'sub', p_uid,
             'is_anonymous', coalesce(p_anonymous, false)
           )::text
    end,
    true
  );
end
$$;

-- Freezes earth.utc_now() (the clock every RPC uses) at `p_at`; `null` returns to the real clock.
create or replace function pg_temp.seed_at(p_at timestamptz)
returns void
language plpgsql
as $$
begin
  perform set_config('earth.now', coalesce(p_at::text, ''), true);
end
$$;

-- A message_send-equivalent row: text messages carry a deterministic client id (spec §53), system
-- lines (`p_kind` set) carry the `{kind, actorHumanId}` payload earth.system_message writes. The
-- insert trigger (0250) maintains unread counts, last_message_at and groups.last_activity_at.
create or replace function pg_temp.seed_message(
  p_conversation uuid,
  p_sender uuid,
  p_at timestamptz,
  p_text text,
  p_kind text default null,
  p_reply uuid default null
)
returns uuid
language plpgsql
as $$
declare
  v_hex text;
  v_client uuid;
  v_id uuid;
begin
  if p_kind is null then
    v_hex := md5('earth-seed:' || p_conversation::text || ':' || p_sender::text || ':' || p_at::text || ':' || p_text);
    v_hex := overlay(v_hex placing '4' from 13 for 1);
    v_hex := overlay(v_hex placing '8' from 17 for 1);
    v_client := v_hex::uuid;
  end if;
  insert into public.messages (conversation_id, sender_human_id, type, text, payload, client_id, reply_to_message_id, created_at)
  values (
    p_conversation, p_sender,
    case when p_kind is null then 'text'::public.message_type else 'system'::public.message_type end,
    p_text,
    case when p_kind is null then '{}'::jsonb else jsonb_build_object('kind', p_kind, 'actorHumanId', p_sender) end,
    v_client, p_reply, p_at
  )
  on conflict on constraint messages_client_key do nothing
  returning id into v_id;
  if v_id is null then
    select m.id into v_id
      from public.messages m
     where m.conversation_id = p_conversation and m.sender_human_id = p_sender and m.client_id = v_client;
  end if;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- The fixtures
-- ---------------------------------------------------------------------------------------------------

do $seed$
declare
  -- Credentials (auth.users). Fixed so a developer can sign in as a fixture through GoTrue.
  v_uid_xavier constant uuid := 'a0000000-0000-4000-8000-000000000001';
  v_uid_maya   constant uuid := 'a0000000-0000-4000-8000-000000000002';
  v_uid_kavon  constant uuid := 'a0000000-0000-4000-8000-000000000003';
  v_uid_sarah  constant uuid := 'a0000000-0000-4000-8000-000000000004';
  v_uid_ben    constant uuid := 'a0000000-0000-4000-8000-000000000005';
  v_uid_chris  constant uuid := 'a0000000-0000-4000-8000-000000000006';
  v_uid_alex   constant uuid := 'a0000000-0000-4000-8000-000000000007';
  v_uid_sam    constant uuid := 'a0000000-0000-4000-8000-000000000008';
  -- The anonymous credential behind the Guest of the standalone Live.
  v_uid_guest  constant uuid := 'a0000000-0000-4000-8000-0000000000a1';
  -- Humans. Fixed so tooling and tests can address them.
  v_xavier constant uuid := 'b0000000-0000-4000-8000-000000000001';
  v_maya   constant uuid := 'b0000000-0000-4000-8000-000000000002';
  v_kavon  constant uuid := 'b0000000-0000-4000-8000-000000000003';
  v_sarah  constant uuid := 'b0000000-0000-4000-8000-000000000004';
  v_ben    constant uuid := 'b0000000-0000-4000-8000-000000000005';
  v_chris  constant uuid := 'b0000000-0000-4000-8000-000000000006';
  v_alex   constant uuid := 'b0000000-0000-4000-8000-000000000007';
  v_sam    constant uuid := 'b0000000-0000-4000-8000-000000000008';

  v_humans constant uuid[] := array[v_xavier, v_maya, v_kavon, v_sarah, v_ben, v_chris, v_alex, v_sam];
  v_uids constant uuid[] := array[v_uid_xavier, v_uid_maya, v_uid_kavon, v_uid_sarah, v_uid_ben, v_uid_chris, v_uid_alex, v_uid_sam];
  v_handles constant text[] := array['xavier', 'maya', 'kavon', 'sarah', 'ben', 'chris', 'alex', 'sam'];
  v_names constant text[] := array['Xavier', 'Maya', 'Kavon', 'Sarah', 'Ben', 'Chris', 'Alex', 'Sam'];
  v_emails constant text[] := array[
    'xavier@fixtures.earth.local', 'maya@fixtures.earth.local', 'kavon@fixtures.earth.local',
    'sarah@fixtures.earth.local', 'ben@fixtures.earth.local', 'chris@fixtures.earth.local',
    'alex@fixtures.earth.local', 'sam@fixtures.earth.local'
  ];

  -- The transaction clock: every `default now()` row written by this file carries exactly this value.
  v_now constant timestamptz := now();
  v_nil constant uuid := '00000000-0000-0000-0000-000000000000';

  v_sf uuid;
  v_north_beach uuid;
  v_mission uuid;
  v_dolores_park uuid;

  v_json jsonb;
  v_uid uuid;
  v_col text;
  v_count integer;
  v_check text;

  v_crew_group uuid;
  v_crew_conv uuid;
  v_college_group uuid;
  v_college_conv uuid;
  v_dm uuid;

  v_room_crew uuid;
  v_room_walk uuid;
  v_room_token text;
  v_guest_session uuid;

  v_m uuid;
  v_m_playlist uuid;
  v_m_trieste uuid;
  v_m_sarah_read uuid;
  v_m_blink uuid;
  v_m_jukebox uuid;
  v_m_chris_read uuid;
  v_m_xavier_read uuid;

  v_p_sunrise uuid;
  v_p_walk uuid;
  v_p_bike uuid;
  v_p_playlist uuid;
  v_p_dinner uuid;
  v_p_jukebox uuid;
  v_p_alex uuid;
  v_p_sam uuid;
  v_p_dolores uuid;
  v_p_hike uuid;
  v_r_maya uuid;
begin
  if coalesce(earth.setting('environment'), '') = 'production' then
    raise exception 'fixtures refused: app_settings.environment = production';
  end if;

  -- Base geography (0510_areas_base.sql): San Francisco, North Beach, Mission, Dolores Park.
  select a.id into v_sf from public.areas a where a.slug = 'usa-ca-san-francisco';
  select a.id into v_north_beach from public.areas a where a.slug = 'usa-ca-san-francisco-north-beach';
  select a.id into v_mission from public.areas a where a.slug = 'usa-ca-san-francisco-mission';
  select p.id into v_dolores_park from public.places p where p.provider_reference = 'earth:dolores-park';
  if v_sf is null or v_north_beach is null or v_mission is null or v_dolores_park is null then
    raise exception 'fixtures need the base areas and places of 0510_areas_base.sql';
  end if;

  -- -------------------------------------------------------------------------------------------------
  -- 0. Reset: fixture-owned rows go away (Human ids are fixed, so nothing else can reference them).
  --    Rate-limit windows of the fixture callers are cleared so a re-seed within the hour never trips
  --    a limit the RPCs enforce (spec §83).
  -- -------------------------------------------------------------------------------------------------
  perform pg_temp.seed_as(null);
  perform pg_temp.seed_at(null);
  foreach v_uid in array v_uids || v_uid_guest loop
    perform earth.rate_limit_reset(v_uid::text);
  end loop;

  delete from public.rooms r where r.initiated_by_human_id = any (v_humans);
  delete from public.messages m where m.sender_human_id = any (v_humans);
  delete from public.conversations c
   where c.type = 'direct'
     and exists (
       select 1 from public.conversation_members cm
        where cm.conversation_id = c.id and cm.human_id = any (v_humans)
     );
  delete from public.groups g where g.created_by_human_id = any (v_humans);
  delete from public.media_objects mo where mo.owner_human_id = any (v_humans);
  delete from public.humans h where h.id = any (v_humans);
  -- A credential that took a fixture address under another id (never the case after db:reset).
  delete from auth.users u where lower(u.email) = any (v_emails) and not (u.id = any (v_uids));

  -- -------------------------------------------------------------------------------------------------
  -- 1. Credentials. Upserted by id so GoTrue sessions of a developer signed in as a fixture survive.
  --    instance_id = uuid.Nil and aud/role = authenticated are what GoTrue looks up by email.
  -- -------------------------------------------------------------------------------------------------
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, last_sign_in_at,
    raw_app_meta_data, raw_user_meta_data, is_super_admin, is_sso_user, is_anonymous, created_at, updated_at
  )
  select v_nil, f.uid, 'authenticated', 'authenticated', f.email, '', v_now - interval '40 days', null,
         jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), 'earth_fixture', true),
         jsonb_build_object('earth_fixture', true, 'display_name', f.name),
         false, false, false, v_now - interval '40 days', v_now
    from unnest(v_uids, v_emails, v_names) as f(uid, email, name)
  on conflict (id) do update
    set instance_id = excluded.instance_id,
        aud = excluded.aud,
        role = excluded.role,
        email = excluded.email,
        email_confirmed_at = coalesce(auth.users.email_confirmed_at, excluded.email_confirmed_at),
        raw_app_meta_data = excluded.raw_app_meta_data,
        raw_user_meta_data = excluded.raw_user_meta_data,
        is_sso_user = false,
        is_anonymous = false,
        updated_at = excluded.updated_at;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data,
    is_super_admin, is_sso_user, is_anonymous, created_at, updated_at
  )
  values (
    v_nil, v_uid_guest, 'authenticated', 'authenticated', null, '', '{}'::jsonb,
    jsonb_build_object('earth_fixture', true, 'display_name', 'Jules'),
    false, false, true, v_now - interval '26 hours', v_now
  )
  on conflict (id) do update
    set is_anonymous = true, raw_user_meta_data = excluded.raw_user_meta_data, updated_at = excluded.updated_at;

  -- GoTrue scans these token columns into non-nullable strings: '' is what it writes itself.
  foreach v_col in array array[
    'confirmation_token', 'recovery_token', 'email_change_token_new', 'email_change',
    'email_change_token_current', 'phone_change', 'phone_change_token', 'reauthentication_token'
  ] loop
    if exists (
      select 1 from information_schema.columns c
       where c.table_schema = 'auth' and c.table_name = 'users' and c.column_name = v_col
    ) then
      execute format('update auth.users set %I = %L where id = any ($1) and %I is null', v_col, '', v_col)
        using v_uids || v_uid_guest;
    end if;
  end loop;

  -- The real GoTrue schema (local stack) keeps one identity per credential; the test shim has none.
  if to_regclass('auth.identities') is not null and exists (
    select 1 from information_schema.columns c
     where c.table_schema = 'auth' and c.table_name = 'identities' and c.column_name = 'provider_id'
  ) then
    execute $q$
      insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      select u.id::text, u.id,
             jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true, 'phone_verified', false),
             'email', null, u.created_at, u.updated_at
        from auth.users u
       where u.id = any ($1)
      on conflict (provider_id, provider) do nothing
    $q$ using v_uids;
  end if;

  -- -------------------------------------------------------------------------------------------------
  -- 2. Humans: active, verified through the mock provider, marked as fixtures (spec §16–19, §117).
  -- -------------------------------------------------------------------------------------------------
  insert into public.humans (id, status, human_pass_status, auth_user_id, claim_intent, claim_group_label, is_fixture, created_at, claimed_at, last_active_at)
  select f.human, 'active', 'verified', f.uid, f.intent, f.label, true, f.created, f.created + interval '12 minutes', v_now - f.idle
    from (values
      (v_xavier, v_uid_xavier, 'start_group', 'Weekend Crew', v_now - interval '31 days', interval '2 minutes'),
      (v_maya,   v_uid_maya,   'start_group', 'College',      v_now - interval '46 days', interval '6 minutes'),
      (v_kavon,  v_uid_kavon,  'join_group',  'Weekend Crew', v_now - interval '31 days' + interval '1 hour', interval '3 minutes'),
      (v_sarah,  v_uid_sarah,  'join_group',  'Weekend Crew', v_now - interval '29 days', interval '55 minutes'),
      (v_ben,    v_uid_ben,    'join_group',  'College',      v_now - interval '46 days' + interval '1 hour', interval '20 minutes'),
      (v_chris,  v_uid_chris,  'join_group',  'College',      v_now - interval '46 days' + interval '2 hours', interval '4 hours'),
      (v_alex,   v_uid_alex,   null,          null,           v_now - interval '9 days',  interval '2 days'),
      (v_sam,    v_uid_sam,    'join_group',  'College',      v_now - interval '45 days', interval '9 hours')
    ) as f(human, uid, intent, label, created, idle);

  insert into public.auth_identities (human_id, provider, provider_subject, verified_at)
  select f.human, 'supabase', f.uid::text, h.created_at
    from unnest(v_humans, v_uids) as f(human, uid)
    join public.humans h on h.id = f.human
  union all
  select f.human, 'email', f.email, h.created_at
    from unnest(v_humans, v_emails) as f(human, email)
    join public.humans h on h.id = f.human;

  insert into public.human_passes (human_id, provider, provider_reference, status, risk_level, verified_at)
  select h.id, 'mock', 'mock:fixture:' || f.handle, 'verified', 'low', h.claimed_at - interval '2 minutes'
    from unnest(v_humans, v_handles) as f(human, handle)
    join public.humans h on h.id = f.human;

  insert into private.human_pass_metadata (human_pass_id, metadata)
  select hp.id, jsonb_build_object('fixture', true, 'provider', 'mock', 'note', 'development fixture; never a real verification')
    from public.human_passes hp
   where hp.human_id = any (v_humans);

  insert into public.public_identities (human_id, display_name, handle, bio, home_city_area_id, public_city_visibility, profile_visibility)
  values
    (v_xavier, 'Xavier', 'xavier', 'North Beach. Sunrise walks, late dinners. Weekend Crew ringleader.', v_sf, true, 'public'),
    (v_maya,   'Maya',   'maya',   'Mission resident, bakery critic, keeper of the College group chat.', v_sf, true, 'public'),
    (v_kavon,  'Kavon',  'kavon',  'Fixes bikes, loses at chess in Washington Square.', v_sf, true, 'public'),
    (v_sarah,  'Sarah',  'sarah',  'Playlists for long walks. Mission, mostly.', v_sf, true, 'public'),
    (v_ben,    'Ben',    'ben',    'Hosts dinners with no plan and it works out.', v_sf, true, 'public'),
    (v_chris,  'Chris',  'chris',  'Replies eventually. Jukebox historian.', v_sf, true, 'public'),
    (v_alex,   'Alex',   'alex',   'New here. North Beach by way of Portland.', v_sf, false, 'public'),
    (v_sam,    'Sam',    'sam',    'Mission newcomer, looking for the good taco.', v_sf, true, 'public');

  insert into public.human_presence (human_id, last_active_at, active_conversation_id, active_room_id, platform)
  values
    (v_xavier, v_now - interval '2 minutes', null, null, 'ios'),
    (v_maya,   v_now - interval '6 minutes', null, null, 'android'),
    (v_kavon,  v_now - interval '3 minutes', null, null, 'ios'),
    (v_sarah,  v_now - interval '55 minutes', null, null, 'web'),
    (v_ben,    v_now - interval '20 minutes', null, null, 'ios'),
    (v_chris,  v_now - interval '4 hours', null, null, 'android'),
    (v_alex,   v_now - interval '2 days', null, null, 'web'),
    (v_sam,    v_now - interval '9 hours', null, null, 'ios');

  -- -------------------------------------------------------------------------------------------------
  -- 3. Area context through context_set (spec §51/§74: area ids only, never coordinates).
  -- -------------------------------------------------------------------------------------------------
  perform pg_temp.seed_as(v_uid_xavier); perform public.context_set(v_north_beach, v_sf, v_sf);
  perform pg_temp.seed_as(v_uid_maya);   perform public.context_set(v_mission, v_sf, v_sf);
  perform pg_temp.seed_as(v_uid_kavon);  perform public.context_set(v_north_beach, v_sf, v_sf);
  perform pg_temp.seed_as(v_uid_sarah);  perform public.context_set(v_mission, v_sf, v_sf);
  perform pg_temp.seed_as(v_uid_ben);    perform public.context_set(v_mission, v_sf, v_sf);
  perform pg_temp.seed_as(v_uid_chris);  perform public.context_set(v_north_beach, v_sf, v_sf);
  perform pg_temp.seed_as(v_uid_alex);   perform public.context_set(v_north_beach, v_sf, v_sf);
  perform pg_temp.seed_as(v_uid_sam);    perform public.context_set(v_mission, v_sf, v_sf);

  -- -------------------------------------------------------------------------------------------------
  -- 4. Social graph through the RPCs (spec §20): a request each way makes a friendship, with the
  --    friend_request / friend_accepted notifications real traffic would leave behind.
  -- -------------------------------------------------------------------------------------------------
  perform pg_temp.seed_as(v_uid_xavier); perform public.friend_request_send(v_maya);
  perform pg_temp.seed_as(v_uid_maya);   perform public.friend_request_send(v_xavier);
  perform pg_temp.seed_as(v_uid_xavier); perform public.friend_request_send(v_kavon);
  perform pg_temp.seed_as(v_uid_kavon);  perform public.friend_request_send(v_xavier);
  perform pg_temp.seed_as(v_uid_kavon);  perform public.friend_request_send(v_maya);
  perform pg_temp.seed_as(v_uid_maya);   perform public.friend_request_send(v_kavon);
  perform pg_temp.seed_as(v_uid_maya);   perform public.friend_request_send(v_sarah);
  perform pg_temp.seed_as(v_uid_sarah);  perform public.friend_request_send(v_maya);
  perform pg_temp.seed_as(v_uid_ben);    perform public.friend_request_send(v_chris);
  perform pg_temp.seed_as(v_uid_chris);  perform public.friend_request_send(v_ben);
  perform pg_temp.seed_as(v_uid_sarah);  perform public.friend_request_send(v_ben);
  perform pg_temp.seed_as(v_uid_ben);    perform public.friend_request_send(v_sarah);
  if not (earth.are_friends(v_xavier, v_maya) and earth.are_friends(v_xavier, v_kavon) and earth.are_friends(v_kavon, v_maya)
          and earth.are_friends(v_maya, v_sarah) and earth.are_friends(v_ben, v_chris) and earth.are_friends(v_sarah, v_ben)) then
    raise exception 'fixtures: friendships were not created';
  end if;
  update public.relationships r set created_at = v_now - interval '21 days'
   where r.type = 'friend' and r.source_human_id = any (v_humans) and r.created_at = v_now;
  with numbered as (
    select n.id, row_number() over (order by n.created_at, n.id) as rn
      from public.notifications n
     where n.recipient_human_id = any (v_humans) and n.created_at = v_now
  )
  update public.notifications n
     set created_at = v_now - interval '21 days' + numbered.rn * interval '7 hours',
         read_at = v_now - interval '21 days' + numbered.rn * interval '7 hours' + interval '25 minutes'
    from numbered
   where n.id = numbered.id;

  -- Follows (Alex → Xavier, Sam → Maya) and one pending request Kavon can still answer (Alex → Kavon).
  perform pg_temp.seed_as(v_uid_alex); perform public.follow_set(v_xavier, true); perform public.friend_request_send(v_kavon);
  perform pg_temp.seed_as(v_uid_sam);  perform public.follow_set(v_maya, true);
  update public.relationships r set created_at = v_now - interval '26 hours'
   where r.type = 'follow' and r.source_human_id = any (v_humans) and r.created_at = v_now;
  update public.relationships r set created_at = v_now - interval '5 hours'
   where r.type = 'friend_pending' and r.source_human_id = any (v_humans) and r.created_at = v_now;
  update public.notifications n set created_at = v_now - interval '26 hours'
   where n.recipient_human_id = any (v_humans) and n.created_at = v_now and n.type = 'follow';
  update public.notifications n set created_at = v_now - interval '5 hours'
   where n.recipient_human_id = any (v_humans) and n.created_at = v_now and n.type = 'friend_request';

  -- -------------------------------------------------------------------------------------------------
  -- 5. Groups (spec §22–24). Owners create through group_create; the invites carry the documented
  --    tokens; every other member joins through group_invite_join with that token (use_count counts).
  -- -------------------------------------------------------------------------------------------------
  perform pg_temp.seed_as(v_uid_xavier);
  v_json := public.group_create('Weekend Crew');
  v_crew_group := (v_json ->> 'id')::uuid;
  v_crew_conv := (v_json ->> 'conversationId')::uuid;
  insert into public.group_invites (group_id, created_by, token_hash, expires_at, max_uses, status)
  values (v_crew_group, v_xavier, earth.sha256_hex('weekend-crew-dev-token'), null, null, 'active');
  perform pg_temp.seed_as(v_uid_maya);  perform public.group_invite_join('weekend-crew-dev-token');
  perform pg_temp.seed_as(v_uid_kavon); perform public.group_invite_join('weekend-crew-dev-token');
  perform pg_temp.seed_as(v_uid_sarah); perform public.group_invite_join('weekend-crew-dev-token');

  perform pg_temp.seed_as(v_uid_maya);
  v_json := public.group_create('College');
  v_college_group := (v_json ->> 'id')::uuid;
  v_college_conv := (v_json ->> 'conversationId')::uuid;
  insert into public.group_invites (group_id, created_by, token_hash, expires_at, max_uses, status)
  values (v_college_group, v_maya, earth.sha256_hex('college-dev-token'), null, null, 'active');
  perform pg_temp.seed_as(v_uid_ben);   perform public.group_invite_join('college-dev-token');
  perform pg_temp.seed_as(v_uid_chris); perform public.group_invite_join('college-dev-token');
  perform pg_temp.seed_as(v_uid_sam);   perform public.group_invite_join('college-dev-token');

  select g.member_count into v_count from public.groups g where g.id = v_crew_group;
  if v_count <> 4 then
    raise exception 'fixtures: Weekend Crew has % members, expected 4', v_count;
  end if;
  select g.member_count into v_count from public.groups g where g.id = v_college_group;
  if v_count <> 4 then
    raise exception 'fixtures: College has % members, expected 4', v_count;
  end if;

  -- One direct conversation (Xavier ↔ Maya) for the Chats list.
  perform pg_temp.seed_as(v_uid_xavier);
  v_json := public.conversation_direct_get_or_create(v_maya);
  v_dm := (v_json ->> 'id')::uuid;

  -- History: the groups are weeks old; memberships arrived over the first days.
  update public.groups g set created_at = v_now - interval '31 days' where g.id = v_crew_group;
  update public.groups g set created_at = v_now - interval '46 days' where g.id = v_college_group;
  update public.conversations c set created_at = g.created_at from public.groups g where g.id = c.group_id and g.id in (v_crew_group, v_college_group);
  update public.conversations c set created_at = v_now - interval '20 days' where c.id = v_dm;
  update public.group_invites gi set created_at = g.created_at + interval '30 minutes' from public.groups g where g.id = gi.group_id and g.id in (v_crew_group, v_college_group);
  update public.group_members gm set joined_at = g.created_at + f.after
    from public.groups g,
         (values
            (v_crew_group, v_xavier,   interval '0'),
            (v_crew_group, v_maya,     interval '1 hour'),
            (v_crew_group, v_kavon,    interval '1 hour 5 minutes'),
            (v_crew_group, v_sarah,    interval '2 days'),
            (v_college_group, v_maya,  interval '0'),
            (v_college_group, v_ben,   interval '1 hour'),
            (v_college_group, v_chris, interval '2 hours'),
            (v_college_group, v_sam,   interval '1 day')
         ) as f(group_id, human_id, after)
   where g.id = f.group_id and gm.group_id = f.group_id and gm.human_id = f.human_id;
  update public.conversation_members cm set joined_at = gm.joined_at
    from public.conversations c
    join public.group_members gm on gm.group_id = c.group_id
   where c.id = cm.conversation_id and gm.human_id = cm.human_id and c.group_id in (v_crew_group, v_college_group);
  update public.conversation_members cm set joined_at = v_now - interval '20 days' where cm.conversation_id = v_dm;

  -- -------------------------------------------------------------------------------------------------
  -- 6. Lives (spec §57–§62; ARCHITECTURE §10), replayed on the frozen clock.
  --    a) Weekend Crew room three hours ago: Xavier on camera, Maya on camera (consenting to friends),
  --       Kavon on audio; Xavier opens up to friends, which waits for Kavon's consent; ended by Xavier
  --       two hours ago.
  -- -------------------------------------------------------------------------------------------------
  perform pg_temp.seed_at(v_now - interval '3 hours');
  perform pg_temp.seed_as(v_uid_xavier);
  v_json := public.room_start('group', v_crew_group, 'Saturday plans');
  v_room_crew := (v_json -> 'room' ->> 'id')::uuid;
  perform pg_temp.seed_at(v_now - interval '3 hours' + interval '2 minutes');
  perform pg_temp.seed_as(v_uid_maya);
  perform public.room_join(v_room_crew, 'camera', 'friends');
  perform pg_temp.seed_at(v_now - interval '3 hours' + interval '4 minutes');
  perform pg_temp.seed_as(v_uid_kavon);
  perform public.room_join(v_room_crew, 'audio', 'group');
  perform pg_temp.seed_at(v_now - interval '3 hours' + interval '6 minutes');
  perform pg_temp.seed_as(v_uid_xavier);
  v_json := public.room_set_visibility(v_room_crew, 'friends', null::public.room_join_policy);
  if (v_json ->> 'applied')::boolean then
    raise exception 'fixtures: opening up should wait for Kavon''s consent';
  end if;
  perform pg_temp.seed_at(v_now - interval '3 hours' + interval '7 minutes');
  perform pg_temp.seed_as(v_uid_kavon);
  v_json := public.room_consent(v_room_crew, 'friends');
  select r.visibility::text into v_check from public.rooms r where r.id = v_room_crew;
  if v_check <> 'friends' then
    raise exception 'fixtures: Weekend Crew room visibility is %, expected friends', v_check;
  end if;
  perform pg_temp.seed_at(v_now - interval '2 hours');
  perform pg_temp.seed_as(v_uid_xavier);
  perform public.room_end(v_room_crew, 'moderator');
  update public.notifications n
     set created_at = v_now - interval '3 hours' + interval '1 minute',
         read_at = v_now - interval '2 hours' - interval '30 minutes'
   where n.recipient_human_id = any (v_humans) and n.created_at = v_now
     and n.object_type = 'room' and n.object_id = v_room_crew;

  --    b) Standalone Live by Sarah yesterday (friends / friends): Ben joins on audio, Sarah shares a
  --       link, a Guest ("Jules") joins through it; ended by Sarah an hour later.
  perform pg_temp.seed_at(v_now - interval '26 hours');
  perform pg_temp.seed_as(v_uid_sarah);
  v_json := public.room_start('standalone', null::uuid, 'Coffee walk in the Mission');
  v_room_walk := (v_json -> 'room' ->> 'id')::uuid;
  perform pg_temp.seed_at(v_now - interval '26 hours' + interval '3 minutes');
  perform pg_temp.seed_as(v_uid_ben);
  perform public.room_join(v_room_walk, 'audio', 'friends');
  perform pg_temp.seed_at(v_now - interval '26 hours' + interval '4 minutes');
  perform pg_temp.seed_as(v_uid_sarah);
  v_json := public.room_invite_create(v_room_walk, 3600, null::public.room_join_policy);
  v_room_token := v_json ->> 'token';
  perform pg_temp.seed_at(v_now - interval '26 hours' + interval '6 minutes');
  perform pg_temp.seed_as(v_uid_guest, true);
  v_json := public.guest_session_create(v_room_token, 'Jules', 'fixture-device-jules-0001', 'audio');
  v_guest_session := (v_json ->> 'guestSessionId')::uuid;
  perform pg_temp.seed_at(v_now - interval '25 hours');
  perform pg_temp.seed_as(v_uid_sarah);
  perform public.room_end(v_room_walk, 'moderator');
  update public.notifications n
     set created_at = v_now - interval '26 hours' + interval '1 minute',
         read_at = v_now - interval '25 hours'
   where n.recipient_human_id = any (v_humans) and n.created_at = v_now
     and n.object_type = 'room' and n.object_id = v_room_walk;
  perform pg_temp.seed_at(null);
  perform pg_temp.seed_as(null);

  select count(*) into v_count from public.rooms r where r.id in (v_room_crew, v_room_walk) and r.status = 'ended';
  if v_count <> 2 then
    raise exception 'fixtures: expected both Lives to be ended';
  end if;

  -- -------------------------------------------------------------------------------------------------
  -- 7. Chat history (spec §27, §53). The RPC-written system lines ("Maya joined", "Xavier started a
  --    video") are re-written with their real timestamps inside the three-day history.
  -- -------------------------------------------------------------------------------------------------
  delete from public.messages m where m.conversation_id in (v_crew_conv, v_college_conv, v_dm);

  -- Weekend Crew ---------------------------------------------------------------------------------
  perform pg_temp.seed_message(v_crew_conv, v_maya,  v_now - interval '31 days' + interval '1 hour', 'Maya joined', 'member_joined');
  perform pg_temp.seed_message(v_crew_conv, v_kavon, v_now - interval '31 days' + interval '1 hour 5 minutes', 'Kavon joined', 'member_joined');
  perform pg_temp.seed_message(v_crew_conv, v_sarah, v_now - interval '29 days', 'Sarah joined', 'member_joined');
  perform pg_temp.seed_message(v_crew_conv, v_xavier, v_now - interval '72 hours', $q$Okay who's around this weekend?$q$);
  perform pg_temp.seed_message(v_crew_conv, v_maya,   v_now - interval '71 hours 50 minutes', 'Me! Back in the city Friday night');
  perform pg_temp.seed_message(v_crew_conv, v_kavon,  v_now - interval '71 hours 30 minutes', 'Here. Free Saturday, busy Sunday');
  perform pg_temp.seed_message(v_crew_conv, v_sarah,  v_now - interval '70 hours', $q$I'm in. Weather looks good Saturday$q$);
  perform pg_temp.seed_message(v_crew_conv, v_xavier, v_now - interval '69 hours', 'Hike + late lunch? Lands End, then the Mission');
  perform pg_temp.seed_message(v_crew_conv, v_maya,   v_now - interval '68 hours 55 minutes', 'Yes to both. Tartine after?');
  perform pg_temp.seed_message(v_crew_conv, v_kavon,  v_now - interval '68 hours 40 minutes', 'Tartine line will be an hour, just saying');
  perform pg_temp.seed_message(v_crew_conv, v_sarah,  v_now - interval '68 hours 30 minutes', 'Worth it though');
  perform pg_temp.seed_message(v_crew_conv, v_xavier, v_now - interval '52 hours', $q$Update: my brother is visiting, so he's joining. He's harmless$q$);
  perform pg_temp.seed_message(v_crew_conv, v_maya,   v_now - interval '51 hours', 'The more the merrier');
  perform pg_temp.seed_message(v_crew_conv, v_kavon,  v_now - interval '50 hours', 'Does he hike or does he complain');
  perform pg_temp.seed_message(v_crew_conv, v_xavier, v_now - interval '49 hours 50 minutes', 'Both, at the same time');
  perform pg_temp.seed_message(v_crew_conv, v_sarah,  v_now - interval '49 hours', $q$lol perfect, he'll fit right in$q$);
  perform pg_temp.seed_message(v_crew_conv, v_maya,   v_now - interval '30 hours', 'Reminder that Sarah still owes us the playlist');
  perform pg_temp.seed_message(v_crew_conv, v_sarah,  v_now - interval '29 hours 50 minutes', $q$It's coming!! Tonight$q$);
  v_m_playlist := pg_temp.seed_message(v_crew_conv, v_sarah, v_now - interval '27 hours', 'Playlist is up. Three hours of walking music');
  perform pg_temp.seed_message(v_crew_conv, v_kavon,  v_now - interval '26 hours 50 minutes', 'Sarah delivered');
  v_m_trieste := pg_temp.seed_message(v_crew_conv, v_xavier, v_now - interval '26 hours', 'Tomorrow: 10am at the Lands End parking lot. Coffee at Caffe Trieste first for anyone in North Beach');
  perform pg_temp.seed_message(v_crew_conv, v_kavon,  v_now - interval '25 hours 30 minutes', 'Trieste at 9 then');
  perform pg_temp.seed_message(v_crew_conv, v_maya,   v_now - interval '25 hours', '9:15 for me, coming from the Mission');
  perform pg_temp.seed_message(v_crew_conv, v_sarah,  v_now - interval '9 hours', 'Morning! Leaving now');
  perform pg_temp.seed_message(v_crew_conv, v_xavier, v_now - interval '8 hours 55 minutes', 'Same. Kavon are you up');
  perform pg_temp.seed_message(v_crew_conv, v_kavon,  v_now - interval '8 hours 50 minutes', 'Up. Barely.');
  perform pg_temp.seed_message(v_crew_conv, v_maya,   v_now - interval '8 hours 30 minutes', 'Trieste has a table by the window, grabbing it');
  perform pg_temp.seed_message(v_crew_conv, v_xavier, v_now - interval '3 hours', 'Xavier started a video', 'room_started');
  perform pg_temp.seed_message(v_crew_conv, v_xavier, v_now - interval '2 hours 58 minutes', 'Going live for a sec so Sarah can see the view');
  perform pg_temp.seed_message(v_crew_conv, v_sarah,  v_now - interval '2 hours 55 minutes', 'You all look freezing');
  perform pg_temp.seed_message(v_crew_conv, v_maya,   v_now - interval '2 hours 50 minutes', $q$It's the fog, it's character building$q$);
  v_m_sarah_read := pg_temp.seed_message(v_crew_conv, v_kavon, v_now - interval '1 hour 30 minutes', 'Lunch was great. Photos later');
  perform pg_temp.seed_message(v_crew_conv, v_sarah,  v_now - interval '1 hour', $q$Next weekend: Ben's place for dinner? He offered$q$);
  perform pg_temp.seed_message(v_crew_conv, v_xavier, v_now - interval '40 minutes', $q$In. Tell him I'll bring bread$q$);
  perform pg_temp.seed_message(v_crew_conv, v_maya,   v_now - interval '25 minutes', 'Same. This crew is undefeated');
  perform pg_temp.seed_message(v_crew_conv, v_kavon,  v_now - interval '6 minutes', 'Undefeated and tired. Nap time');

  -- College --------------------------------------------------------------------------------------
  perform pg_temp.seed_message(v_college_conv, v_ben,   v_now - interval '46 days' + interval '1 hour', 'Ben joined', 'member_joined');
  perform pg_temp.seed_message(v_college_conv, v_chris, v_now - interval '46 days' + interval '2 hours', 'Chris joined', 'member_joined');
  perform pg_temp.seed_message(v_college_conv, v_sam,   v_now - interval '45 days', 'Sam joined', 'member_joined');
  perform pg_temp.seed_message(v_college_conv, v_maya,  v_now - interval '70 hours', 'Reunion planning thread, take two');
  perform pg_temp.seed_message(v_college_conv, v_ben,   v_now - interval '69 hours 30 minutes', 'Take two because Chris never replied to take one');
  perform pg_temp.seed_message(v_college_conv, v_chris, v_now - interval '69 hours', 'I replied! In my head');
  perform pg_temp.seed_message(v_college_conv, v_sam,   v_now - interval '68 hours', 'Classic Chris');
  perform pg_temp.seed_message(v_college_conv, v_maya,  v_now - interval '67 hours', 'Dates: Oct 18 or Oct 25? Both Saturdays');
  perform pg_temp.seed_message(v_college_conv, v_ben,   v_now - interval '66 hours 30 minutes', $q$18 works. 25 I'm in LA$q$);
  perform pg_temp.seed_message(v_college_conv, v_chris, v_now - interval '66 hours', 'Either');
  perform pg_temp.seed_message(v_college_conv, v_sam,   v_now - interval '65 hours', $q$18. Let's lock it$q$);
  perform pg_temp.seed_message(v_college_conv, v_maya,  v_now - interval '64 hours 55 minutes', 'Oct 18 locked. Now: where');
  perform pg_temp.seed_message(v_college_conv, v_ben,   v_now - interval '48 hours', 'Voting for the Mission. Walkable, good tacos, nobody drives');
  perform pg_temp.seed_message(v_college_conv, v_chris, v_now - interval '47 hours', $q$Seconded. La Taqueria, then Dolores Park if it's sunny$q$);
  perform pg_temp.seed_message(v_college_conv, v_sam,   v_now - interval '46 hours', $q$Dolores Park at 2pm is a personality test, I'm in$q$);
  perform pg_temp.seed_message(v_college_conv, v_maya,  v_now - interval '45 hours', $q$Great. I'll send the invite link to the others tonight$q$);
  perform pg_temp.seed_message(v_college_conv, v_maya,  v_now - interval '44 hours', 'Sent. Priya and Dev are joining, Marcus is a maybe');
  perform pg_temp.seed_message(v_college_conv, v_ben,   v_now - interval '43 hours 30 minutes', 'Marcus is always a maybe');
  perform pg_temp.seed_message(v_college_conv, v_sam,   v_now - interval '24 hours', 'Does anyone still have the group photo from graduation? Need it for a thing');
  v_m_blink := pg_temp.seed_message(v_college_conv, v_chris, v_now - interval '23 hours', 'I have the one where Ben is blinking');
  perform pg_temp.seed_message(v_college_conv, v_ben,   v_now - interval '22 hours 50 minutes', 'There are no others');
  perform pg_temp.seed_message(v_college_conv, v_maya,  v_now - interval '22 hours', $q$I'll dig through my drive tonight$q$);
  perform pg_temp.seed_message(v_college_conv, v_sam,   v_now - interval '21 hours', 'Thanks!! No rush');
  perform pg_temp.seed_message(v_college_conv, v_maya,  v_now - interval '20 hours', 'Found three. Sending in the DM');
  perform pg_temp.seed_message(v_college_conv, v_chris, v_now - interval '8 hours', 'Random but the pizza place on Valencia we used to go to reopened');
  perform pg_temp.seed_message(v_college_conv, v_ben,   v_now - interval '7 hours 40 minutes', 'The one with the broken jukebox?');
  v_m_jukebox := pg_temp.seed_message(v_college_conv, v_chris, v_now - interval '7 hours 30 minutes', 'Fixed the jukebox, apparently');
  perform pg_temp.seed_message(v_college_conv, v_sam,   v_now - interval '7 hours', 'Well now I have to go');
  v_m_chris_read := pg_temp.seed_message(v_college_conv, v_maya, v_now - interval '6 hours', 'Field trip before the reunion?');
  perform pg_temp.seed_message(v_college_conv, v_ben,   v_now - interval '5 hours 50 minutes', 'Thursday?');
  perform pg_temp.seed_message(v_college_conv, v_sam,   v_now - interval '5 hours 30 minutes', 'Thursday works');
  perform pg_temp.seed_message(v_college_conv, v_chris, v_now - interval '5 hours', $q$Thursday. I'll book, if they even take bookings$q$);
  perform pg_temp.seed_message(v_college_conv, v_maya,  v_now - interval '2 hours', 'Chris booking something is the real reunion');
  perform pg_temp.seed_message(v_college_conv, v_ben,   v_now - interval '15 minutes', 'Screenshot for the archives');

  -- Xavier ↔ Maya ---------------------------------------------------------------------------------
  perform pg_temp.seed_message(v_dm, v_xavier, v_now - interval '26 hours 30 minutes', 'Can you grab the good bread from Acme before Saturday?');
  perform pg_temp.seed_message(v_dm, v_maya,   v_now - interval '26 hours 20 minutes', 'Already on my list. Sourdough or the seeded one?');
  perform pg_temp.seed_message(v_dm, v_xavier, v_now - interval '26 hours', 'Both. My brother eats like a horse');
  perform pg_temp.seed_message(v_dm, v_maya,   v_now - interval '25 hours 50 minutes', 'Noted');
  perform pg_temp.seed_message(v_dm, v_maya,   v_now - interval '3 hours 10 minutes', 'Are you going live in the group chat? Sarah wants to see the view');
  perform pg_temp.seed_message(v_dm, v_xavier, v_now - interval '3 hours 5 minutes', 'Doing it now');
  perform pg_temp.seed_message(v_dm, v_maya,   v_now - interval '50 minutes', 'That was fun. Same time next week?');
  v_m_xavier_read := pg_temp.seed_message(v_dm, v_xavier, v_now - interval '45 minutes', 'Deal');
  perform pg_temp.seed_message(v_dm, v_maya,   v_now - interval '20 minutes', 'Also you still owe me $14 for the coffee');

  -- Reactions through the RPC (spec §28).
  perform pg_temp.seed_as(v_uid_xavier); perform public.message_reaction_toggle(v_m_playlist, '❤️');
  perform pg_temp.seed_as(v_uid_maya);   perform public.message_reaction_toggle(v_m_playlist, '🙌');
  perform pg_temp.seed_as(v_uid_kavon);  perform public.message_reaction_toggle(v_m_trieste, '☕');
  perform pg_temp.seed_as(v_uid_sam);    perform public.message_reaction_toggle(v_m_jukebox, '😂');
  perform pg_temp.seed_as(v_uid_ben);    perform public.message_reaction_toggle(v_m_blink, '😂');
  perform pg_temp.seed_as(null);

  -- Read state (spec §55): everyone is caught up except Sarah (Weekend Crew), Chris (College) and
  -- Xavier (the DM), so the Chats list has real unread badges.
  update public.conversation_members cm
     set last_read_message_id = (select m.id from public.messages m where m.conversation_id = cm.conversation_id order by m.created_at desc, m.id desc limit 1),
         last_read_at = (select max(m.created_at) from public.messages m where m.conversation_id = cm.conversation_id)
   where cm.conversation_id in (v_crew_conv, v_college_conv, v_dm);
  update public.conversation_members cm
     set last_read_message_id = f.message_id,
         last_read_at = (select m.created_at from public.messages m where m.id = f.message_id)
    from (values
           (v_crew_conv, v_sarah, v_m_sarah_read),
           (v_college_conv, v_chris, v_m_chris_read),
           (v_dm, v_xavier, v_m_xavier_read)
         ) as f(conversation_id, human_id, message_id)
   where cm.conversation_id = f.conversation_id and cm.human_id = f.human_id;
  update public.conversation_members cm
     set unread_count = (
       select count(*) from public.messages m
        where m.conversation_id = cm.conversation_id
          and m.created_at > cm.last_read_at
          and m.sender_human_id <> cm.human_id
     )
   where cm.conversation_id in (v_crew_conv, v_college_conv, v_dm);
  update public.conversations c
     set last_message_at = (select max(m.created_at) from public.messages m where m.conversation_id = c.id)
   where c.id in (v_crew_conv, v_college_conv, v_dm);
  update public.groups g
     set last_activity_at = (
       select max(m.created_at) from public.messages m
       join public.conversations c on c.id = m.conversation_id
       where c.group_id = g.id
     )
   where g.id in (v_crew_group, v_college_group);

  -- -------------------------------------------------------------------------------------------------
  -- 8. Places (spec §38, §76): a few North Beach / Mission spots, marked as fixtures.
  -- -------------------------------------------------------------------------------------------------
  perform earth.place_upsert('caffe-trieste', 'Caffe Trieste', 'usa-ca-san-francisco-north-beach', 37.7985, -122.4073, 'cafe', true);
  perform earth.place_upsert('coit-tower', 'Coit Tower', 'usa-ca-san-francisco-north-beach', 37.8024, -122.4058, 'landmark', true);
  perform earth.place_upsert('mission-dolores', 'Mission Dolores', 'usa-ca-san-francisco-mission', 37.7642, -122.4270, 'landmark', true);
  perform earth.place_upsert('clarion-alley', 'Clarion Alley', 'usa-ca-san-francisco-mission', 37.7629, -122.4213, 'landmark', true);

  -- -------------------------------------------------------------------------------------------------
  -- 9. Posts through post_create (spec §29, §63): World by every fixture, San Francisco city posts,
  --    North Beach / Mission neighborhood posts (area from the author's context), friends posts, a
  --    Dolores Park moment and one reply thread. Chronological, on the frozen clock.
  -- -------------------------------------------------------------------------------------------------
  perform pg_temp.seed_at(v_now - interval '70 hours'); perform pg_temp.seed_as(v_uid_xavier);
  v_json := public.post_create(type => 'text', text => $q$First fog-free sunrise from Telegraph Hill in weeks. North Beach, you're beautiful.$q$, audience => 'world');
  v_p_sunrise := (v_json -> 'post' ->> 'id')::uuid;

  perform pg_temp.seed_at(v_now - interval '69 hours'); perform pg_temp.seed_as(v_uid_maya);
  v_json := public.post_create(type => 'text', text => $q$You're forgiven for the 6am text$q$, audience => 'world', parent_post_id => v_p_sunrise);
  v_r_maya := (v_json -> 'post' ->> 'id')::uuid;

  perform pg_temp.seed_at(v_now - interval '68 hours'); perform pg_temp.seed_as(v_uid_kavon);
  perform public.post_create(type => 'text', text => 'Send the photo!', audience => 'world', parent_post_id => v_p_sunrise);

  perform pg_temp.seed_at(v_now - interval '67 hours'); perform pg_temp.seed_as(v_uid_xavier);
  perform public.post_create(type => 'text', text => 'Never. The text was the point.', audience => 'world', parent_post_id => v_r_maya);

  perform pg_temp.seed_at(v_now - interval '60 hours'); perform pg_temp.seed_as(v_uid_maya);
  v_json := public.post_create(type => 'text', text => 'Reminder that the best things in a city are the ones you walk to. Mission edition: bakery, park, bookstore, home.', audience => 'world');
  v_p_walk := (v_json -> 'post' ->> 'id')::uuid;

  perform pg_temp.seed_at(v_now - interval '55 hours'); perform pg_temp.seed_as(v_uid_xavier);
  perform public.post_create(type => 'text', text => 'Lands End trail is dry again after the rain. Go early, the parking lot fills by 10.', audience => 'city');

  perform pg_temp.seed_at(v_now - interval '52 hours'); perform pg_temp.seed_as(v_uid_maya);
  v_p_hike := (public.post_create(type => 'text', text => 'Not to be dramatic but the crew hike on Saturday is the highlight of my month.', audience => 'friends') -> 'post' ->> 'id')::uuid;

  perform pg_temp.seed_at(v_now - interval '48 hours'); perform pg_temp.seed_as(v_uid_kavon);
  v_json := public.post_create(type => 'text', text => $q$Spent the morning fixing a bike I found on the curb. It works. I'm unreasonably proud.$q$, audience => 'world');
  v_p_bike := (v_json -> 'post' ->> 'id')::uuid;

  perform pg_temp.seed_at(v_now - interval '44 hours'); perform pg_temp.seed_as(v_uid_xavier);
  perform public.post_create(type => 'text', text => $q$Caffe Trieste has the window table free most mornings before 9. That's the tip.$q$, audience => 'neighborhood');

  perform pg_temp.seed_at(v_now - interval '40 hours'); perform pg_temp.seed_as(v_uid_sarah);
  v_json := public.post_create(type => 'text', text => 'Made a three-hour walking playlist for the crew. Taking requests for the encore.', audience => 'world');
  v_p_playlist := (v_json -> 'post' ->> 'id')::uuid;

  perform pg_temp.seed_at(v_now - interval '36 hours'); perform pg_temp.seed_as(v_uid_ben);
  v_json := public.post_create(type => 'text', text => 'Hosting dinner next weekend. Six people, one oven, zero plan. Send recipes.', audience => 'world');
  v_p_dinner := (v_json -> 'post' ->> 'id')::uuid;

  perform pg_temp.seed_at(v_now - interval '33 hours'); perform pg_temp.seed_as(v_uid_sarah);
  perform public.post_create(type => 'text', text => 'PSA: the Mission branch library extended its Saturday hours. Bring the kids, or just yourself.', audience => 'city');

  perform pg_temp.seed_at(v_now - interval '30 hours'); perform pg_temp.seed_as(v_uid_chris);
  v_json := public.post_create(type => 'text', text => 'The jukebox on Valencia is fixed and it still only plays 2009.', audience => 'world');
  v_p_jukebox := (v_json -> 'post' ->> 'id')::uuid;

  perform pg_temp.seed_at(v_now - interval '28 hours'); perform pg_temp.seed_as(v_uid_maya);
  v_json := public.post_create(type => 'moment', text => $q$Dolores Park was 40% dogs this afternoon and I'm not complaining.$q$, audience => 'neighborhood', place_id => v_dolores_park);
  v_p_dolores := (v_json -> 'post' ->> 'id')::uuid;

  perform pg_temp.seed_at(v_now - interval '20 hours'); perform pg_temp.seed_as(v_uid_alex);
  v_json := public.post_create(type => 'text', text => 'New to Earth. Following a few people from the neighborhood, say hi if you see me around North Beach.', audience => 'world');
  v_p_alex := (v_json -> 'post' ->> 'id')::uuid;

  perform pg_temp.seed_at(v_now - interval '16 hours'); perform pg_temp.seed_as(v_uid_kavon);
  perform public.post_create(type => 'text', text => 'Washington Square Park has a new set of chess tables. Winner stays.', audience => 'neighborhood');

  perform pg_temp.seed_at(v_now - interval '12 hours'); perform pg_temp.seed_as(v_uid_ben);
  perform public.post_create(type => 'text', text => $q$Anyone know a good hardware store that isn't a chain? Trying to keep it local.$q$, audience => 'city');

  perform pg_temp.seed_at(v_now - interval '10 hours'); perform pg_temp.seed_as(v_uid_sam);
  v_json := public.post_create(type => 'text', text => 'Trying out Earth. Where do people actually meet up in the Mission?', audience => 'world');
  v_p_sam := (v_json -> 'post' ->> 'id')::uuid;

  perform pg_temp.seed_at(v_now - interval '9 hours'); perform pg_temp.seed_as(v_uid_kavon);
  perform public.post_create(type => 'text', text => 'Photos from the hike coming once I stop being embarrassed by how much I complained.', audience => 'friends');

  perform pg_temp.seed_at(v_now - interval '6 hours'); perform pg_temp.seed_as(v_uid_sarah);
  perform public.post_create(type => 'text', text => $q$Lost a blue scarf somewhere on Valencia between 18th and 20th. If you find it, it's mine and it's cold.$q$, audience => 'neighborhood');

  perform pg_temp.seed_at(v_now - interval '4 hours'); perform pg_temp.seed_as(v_uid_chris);
  perform public.post_create(type => 'text', text => $q$Booked the pizza place for Thursday. They do take bookings. I'm as surprised as you.$q$, audience => 'friends');

  perform pg_temp.seed_at(null);

  -- Reactions through post_reaction_set (spec §31).
  perform pg_temp.seed_as(v_uid_maya);   perform public.post_reaction_set(v_p_sunrise, 'like'); perform public.post_reaction_set(v_p_playlist, 'like');
  perform pg_temp.seed_as(v_uid_kavon);  perform public.post_reaction_set(v_p_sunrise, 'like'); perform public.post_reaction_set(v_p_playlist, 'like');
  perform pg_temp.seed_as(v_uid_sarah);  perform public.post_reaction_set(v_p_sunrise, 'like'); perform public.post_reaction_set(v_p_hike, 'like');
  perform pg_temp.seed_as(v_uid_xavier); perform public.post_reaction_set(v_p_walk, 'like'); perform public.post_reaction_set(v_p_dolores, 'like'); perform public.post_reaction_set(v_p_hike, 'like');
  perform pg_temp.seed_as(v_uid_ben);    perform public.post_reaction_set(v_p_jukebox, 'like'); perform public.post_reaction_set(v_p_bike, 'like');
  perform pg_temp.seed_as(v_uid_chris);  perform public.post_reaction_set(v_p_dinner, 'like');
  perform pg_temp.seed_as(v_uid_alex);   perform public.post_reaction_set(v_p_sunrise, 'like');
  perform pg_temp.seed_as(v_uid_sam);    perform public.post_reaction_set(v_p_walk, 'like'); perform public.post_reaction_set(v_p_alex, 'like');
  perform pg_temp.seed_as(v_uid_maya);   perform public.post_reaction_set(v_p_sam, 'like');
  perform pg_temp.seed_as(null);

  -- -------------------------------------------------------------------------------------------------
  -- 10. Sanity: the inventory README.md documents (supabase/tests/src/seed/seed.test.ts asserts it).
  -- -------------------------------------------------------------------------------------------------
  select count(*) into v_count from public.humans h where h.is_fixture and h.status = 'active' and h.human_pass_status = 'verified';
  if v_count <> 8 then raise exception 'fixtures: % active verified fixture Humans, expected 8', v_count; end if;
  select count(*) into v_count from public.messages m where m.conversation_id = v_crew_conv;
  if v_count <> 36 then raise exception 'fixtures: Weekend Crew has % messages, expected 36', v_count; end if;
  select count(*) into v_count from public.messages m where m.conversation_id = v_college_conv;
  if v_count <> 34 then raise exception 'fixtures: College has % messages, expected 34', v_count; end if;
  select count(*) into v_count from public.messages m where m.conversation_id = v_dm;
  if v_count <> 9 then raise exception 'fixtures: the direct conversation has % messages, expected 9', v_count; end if;
  select count(*) into v_count from public.posts p where p.author_human_id = any (v_humans) and p.status = 'active';
  if v_count <> 21 then raise exception 'fixtures: % posts, expected 21', v_count; end if;
  select count(*) into v_count from public.group_invites gi where gi.group_id in (v_crew_group, v_college_group) and gi.status = 'active' and gi.use_count = 3;
  if v_count <> 2 then raise exception 'fixtures: expected two active invites with three uses each'; end if;
  select count(*) into v_count from public.guest_sessions gs where gs.room_id = v_room_walk;
  if v_count <> 1 then raise exception 'fixtures: expected one Guest session in the standalone Live'; end if;

  raise notice 'fixtures: 8 Humans, 2 groups (%, %), 3 conversations, 2 ended Lives, 21 posts, 4 places',
    v_crew_group, v_college_group;
end
$seed$;

drop function pg_temp.seed_message(uuid, uuid, timestamptz, text, text, uuid);
drop function pg_temp.seed_at(timestamptz);
drop function pg_temp.seed_as(uuid, boolean);
