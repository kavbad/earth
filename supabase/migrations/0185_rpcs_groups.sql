-- 0185 — group and conversation RPCs (DB_API §2, membership only; spec §22–26, §45–47).
--
-- Messages, reactions and read marks land with messaging (02xx); until then summaries carry
-- `lastMessage: null` (or the latest row once `public.messages` exists) and `unreadCount` from the
-- trigger-maintained column. `earth.group_create_internal` and `earth.group_invite_join_internal`
-- are shared with `claim_complete` (0180) so a claim and its group are one transaction.

-- ---------------------------------------------------------------------------------------------------
-- Invite usability (mirror: packages/domain/src/invites/rules.ts — revoked > expired > exhausted)
-- ---------------------------------------------------------------------------------------------------

create or replace function earth.group_invite_usability(p_invite public.group_invites)
returns text
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select case
           when p_invite.status = 'revoked' then 'revoked'
           when p_invite.status = 'expired'
             or (p_invite.expires_at is not null and p_invite.expires_at <= now()) then 'expired'
           when p_invite.status = 'exhausted'
             or (p_invite.max_uses is not null and p_invite.use_count >= p_invite.max_uses) then 'exhausted'
           else 'ok'
         end
$$;

-- The invite for a token hash, or raises `invite_invalid` / `invite_expired` / `invite_exhausted`.
create or replace function earth.assert_group_invite_usable(p_token_hash text)
returns public.group_invites
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_invite public.group_invites%rowtype;
  v_usability text;
begin
  if p_token_hash is null then
    perform earth.raise('invite_invalid');
  end if;
  select * into v_invite from public.group_invites gi where gi.token_hash = p_token_hash;
  if not found then
    perform earth.raise('invite_invalid');
  end if;
  v_usability := earth.group_invite_usability(v_invite);
  if v_usability = 'revoked' then
    perform earth.raise('invite_invalid');
  elsif v_usability = 'expired' then
    perform earth.raise('invite_expired');
  elsif v_usability = 'exhausted' then
    perform earth.raise('invite_exhausted');
  end if;
  if not exists (select 1 from public.groups g where g.id = v_invite.group_id and g.status = 'active') then
    perform earth.raise('invite_invalid');
  end if;
  return v_invite;
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Internals shared with the claim flow
-- ---------------------------------------------------------------------------------------------------

-- Group + owner membership + canonical conversation + conversation member, in the caller's transaction.
create or replace function earth.group_create_internal(
  p_human_id uuid,
  p_name text,
  p_kind public.group_kind default 'persistent',
  out out_group_id uuid,
  out out_conversation_id uuid
)
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
begin
  if p_human_id is null then
    perform earth.raise('invalid_input', 'group_create_internal: human id required');
  end if;
  if v_name is not null and length(v_name) > 60 then
    perform earth.raise('invalid_input', 'name is longer than 60 characters');
  end if;

  insert into public.groups (created_by_human_id, name, kind, last_activity_at)
  values (p_human_id, v_name, coalesce(p_kind, 'persistent'), now())
  returning id into out_group_id;

  insert into public.group_members (group_id, human_id, role, status)
  values (out_group_id, p_human_id, 'owner', 'active');

  insert into public.conversations (type, group_id)
  values ('group', out_group_id)
  returning id into out_conversation_id;

  insert into public.conversation_members (conversation_id, human_id)
  values (out_conversation_id, p_human_id);
end
$$;

-- Inserts a system message once messaging exists (spec §27 columns); no-op before that.
create or replace function earth.system_message(p_conversation_id uuid, p_human_id uuid, p_text text)
returns uuid
language plpgsql
volatile
set search_path = public, earth, private, pg_temp
as $$
declare
  v_id uuid;
begin
  if to_regclass('public.messages') is null then
    return null;
  end if;
  if (select count(*) from information_schema.columns c
       where c.table_schema = 'public' and c.table_name = 'messages'
         and c.column_name in ('conversation_id', 'sender_human_id', 'type', 'text', 'payload')) <> 5 then
    return null;
  end if;
  execute $q$
    insert into public.messages (conversation_id, sender_human_id, type, text, payload)
    values ($1, $2, 'system', $3, '{}'::jsonb)
    returning id
  $q$ into v_id using p_conversation_id, p_human_id, p_text;
  update public.conversations c set last_message_at = now() where c.id = p_conversation_id;
  return v_id;
end
$$;

-- Joins `p_human_id` to the invite's group: validates usability, reactivates a left membership,
-- refuses removed members (`join_not_allowed`), counts the use, ensures conversation membership.
create or replace function earth.group_invite_join_internal(
  p_human_id uuid,
  p_token_hash text,
  out out_group_id uuid,
  out out_conversation_id uuid,
  out out_already_member boolean,
  out out_is_second_group boolean
)
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_invite public.group_invites%rowtype;
  v_member public.group_members%rowtype;
begin
  if p_human_id is null then
    perform earth.raise('invalid_input', 'group_invite_join_internal: human id required');
  end if;
  v_invite := earth.assert_group_invite_usable(p_token_hash);
  out_group_id := v_invite.group_id;
  select c.id into out_conversation_id from public.conversations c where c.group_id = out_group_id;
  if out_conversation_id is null then
    perform earth.raise('internal', 'group without a canonical conversation');
  end if;

  out_is_second_group := exists (
    select 1 from public.group_members gm
     where gm.human_id = p_human_id and gm.status = 'active' and gm.group_id <> out_group_id
  );

  select * into v_member
    from public.group_members gm
   where gm.group_id = out_group_id and gm.human_id = p_human_id
   for update;

  if found and v_member.status = 'active' then
    out_already_member := true;
    insert into public.conversation_members (conversation_id, human_id)
    values (out_conversation_id, p_human_id)
    on conflict on constraint conversation_members_pkey do nothing;
    return;
  end if;
  if found and v_member.status = 'removed' then
    perform earth.raise('join_not_allowed');
  end if;

  out_already_member := false;
  if found then
    update public.group_members gm
       set status = 'active', role = 'member', joined_at = now(), left_at = null, removed_by_human_id = null
     where gm.group_id = out_group_id and gm.human_id = p_human_id;
  else
    insert into public.group_members (group_id, human_id, role, status)
    values (out_group_id, p_human_id, 'member', 'active');
  end if;

  insert into public.conversation_members (conversation_id, human_id)
  values (out_conversation_id, p_human_id)
  on conflict on constraint conversation_members_pkey do nothing;

  update public.group_invites gi
     set use_count = gi.use_count + 1,
         status = case
                    when gi.max_uses is not null and gi.use_count + 1 >= gi.max_uses then 'exhausted'
                    else gi.status
                  end
   where gi.id = v_invite.id;

  update public.groups g set last_activity_at = now() where g.id = out_group_id;

  perform earth.system_message(
    out_conversation_id, p_human_id,
    coalesce(earth.display_name_of(p_human_id), 'Someone') || ' joined'
  );
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- JSON shapes
-- ---------------------------------------------------------------------------------------------------

-- `GroupDto` as seen by `p_viewer`.
create or replace function earth.group_json(p_group_id uuid, p_viewer uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
    'id', g.id,
    'name', g.name,
    'avatarUrl', earth.public_media_url(g.avatar_media_id),
    'kind', g.kind,
    'status', g.status,
    'createdByHumanId', g.created_by_human_id,
    'conversationId', c.id,
    'memberCount', g.member_count,
    'myRole', earth.group_role(g.id, p_viewer),
    'activeRoom', earth.active_room_ref_json(g.active_room_id),
    'createdAt', to_jsonb(g.created_at),
    'lastActivityAt', to_jsonb(g.last_activity_at)
  )
  from public.groups g
  left join public.conversations c on c.group_id = g.id
  where g.id = p_group_id
$$;

-- `GroupMemberDto` (identity + role + isFriend from the viewer's side).
create or replace function earth.group_member_json(p_group_id uuid, p_human_id uuid, p_viewer uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
    'humanId', gm.human_id,
    'displayName', p.display_name,
    'handle', p.handle,
    'avatarUrl', earth.public_media_url(p.avatar_media_id),
    'role', gm.role,
    'status', gm.status,
    'joinedAt', to_jsonb(gm.joined_at),
    'isFriend', earth.are_friends(p_viewer, gm.human_id)
  )
  from public.group_members gm
  join public.public_identities p on p.human_id = gm.human_id
  where gm.group_id = p_group_id and gm.human_id = p_human_id
$$;

-- "Maya", "Maya + Xavier", "Maya, Xavier + Sam", "Maya, Xavier, Sam + 2" (mirror of formatNameList).
create or replace function earth.format_name_list(p_names text[], p_total integer default null)
returns text
language plpgsql
immutable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_clean text[] := array(select btrim(n) from unnest(coalesce(p_names, '{}'::text[])) as n where btrim(coalesce(n, '')) <> '');
  v_shown text[] := v_clean[1:3];
  v_count integer := greatest(coalesce(p_total, coalesce(array_length(v_clean, 1), 0)), coalesce(array_length(v_shown, 1), 0));
  v_rest integer := v_count - coalesce(array_length(v_shown, 1), 0);
begin
  if coalesce(array_length(v_shown, 1), 0) = 0 then
    return case when v_rest > 0 then (case when v_rest = 1 then '1 person' else v_rest || ' people' end) else '' end;
  end if;
  if v_rest > 0 then
    return array_to_string(v_shown, ', ') || ' + ' || v_rest;
  end if;
  if array_length(v_shown, 1) = 1 then
    return v_shown[1];
  end if;
  return array_to_string(v_shown[1:array_length(v_shown, 1) - 1], ', ') || ' + ' || v_shown[array_length(v_shown, 1)];
end
$$;

-- `LastMessagePreviewDto` once messaging exists; null before that or for an empty conversation.
create or replace function earth.last_message_json(p_conversation_id uuid)
returns jsonb
language plpgsql
stable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_json jsonb;
begin
  if to_regclass('public.messages') is null then
    return null;
  end if;
  if (select count(*) from information_schema.columns c
       where c.table_schema = 'public' and c.table_name = 'messages'
         and c.column_name in ('id', 'conversation_id', 'sender_human_id', 'type', 'text', 'created_at', 'deleted_at')) <> 7 then
    return null;
  end if;
  execute $q$
    select jsonb_build_object(
             'id', m.id,
             'senderHumanId', m.sender_human_id,
             'senderDisplayName', coalesce(earth.display_name_of(m.sender_human_id), 'Earth member'),
             'type', m.type,
             'text', m.text,
             'createdAt', to_jsonb(m.created_at)
           )
      from public.messages m
     where m.conversation_id = $1 and m.deleted_at is null
     order by m.created_at desc, m.id desc
     limit 1
  $q$ into v_json using p_conversation_id;
  return v_json;
end
$$;

-- `ConversationSummaryDto` as seen by `p_viewer` (title/avatars from the other members, SCREEN 08/10).
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
    'lastMessageAt', to_jsonb(v_conv.last_message_at)
  );
end
$$;

-- The other Human of a direct conversation (null for groups).
create or replace function earth.direct_other_member(p_conversation_id uuid, p_viewer uuid)
returns uuid
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select cm.human_id
    from public.conversation_members cm
    join public.conversations c on c.id = cm.conversation_id and c.type = 'direct'
   where cm.conversation_id = p_conversation_id and cm.human_id <> p_viewer
   limit 1
$$;

-- ---------------------------------------------------------------------------------------------------
-- Group RPCs
-- ---------------------------------------------------------------------------------------------------

-- The active group or raises `group_not_found`.
create or replace function earth.assert_group(p_group_id uuid)
returns public.groups
language plpgsql
stable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_group public.groups%rowtype;
begin
  if p_group_id is not null then
    select * into v_group from public.groups g where g.id = p_group_id and g.status <> 'deleted';
  end if;
  if v_group.id is null then
    perform earth.raise('group_not_found');
  end if;
  return v_group;
end
$$;

create or replace function public.group_create(name text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_group_id uuid;
  v_conversation_id uuid;
begin
  perform earth.rate_limit_for_caller('group_create', 20, 3600);
  select * into v_group_id, v_conversation_id from earth.group_create_internal(v_me, name);
  return earth.group_json(v_group_id, v_me);
end
$$;

create or replace function public.group_get(group_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_group public.groups := earth.assert_group(group_id);
  v_role public.group_member_role := earth.group_role(v_group.id, v_me);
  v_members jsonb;
  v_invites jsonb := null;
begin
  if v_role is null then
    perform earth.raise('not_a_member');
  end if;

  select coalesce(jsonb_agg(earth.group_member_json(gm.group_id, gm.human_id, v_me) order by gm.joined_at, gm.human_id), '[]'::jsonb)
    into v_members
    from public.group_members gm
    join public.humans h on h.id = gm.human_id and h.status = 'active'
    join public.public_identities p on p.human_id = gm.human_id
   where gm.group_id = v_group.id and gm.status = 'active';

  if v_role in ('owner', 'moderator') then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', gi.id,
             'createdBy', gi.created_by,
             'expiresAt', to_jsonb(gi.expires_at),
             'maxUses', gi.max_uses,
             'useCount', gi.use_count,
             'status', case when earth.group_invite_usability(gi) = 'ok' then gi.status else earth.group_invite_usability(gi) end,
             'createdAt', to_jsonb(gi.created_at)
           ) order by gi.created_at desc), '[]'::jsonb)
      into v_invites
      from public.group_invites gi
     where gi.group_id = v_group.id;
  end if;

  return earth.group_json(v_group.id, v_me)
      || jsonb_build_object('members', v_members)
      || case when v_invites is null then '{}'::jsonb else jsonb_build_object('invites', v_invites) end;
end
$$;

create or replace function public.group_update(group_id uuid, name text default null, avatar_media_id uuid default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_group public.groups := earth.assert_group(group_id);
  v_role public.group_member_role := earth.group_role(v_group.id, v_me);
  v_name text := case when name is null then null else btrim(name) end;
  v_avatar uuid := avatar_media_id;
begin
  perform earth.rate_limit_for_caller('group_update', 60, 3600);
  if v_role is null then
    perform earth.raise('not_a_member');
  end if;
  if v_role not in ('owner', 'moderator') then
    perform earth.raise('not_a_moderator');
  end if;
  if v_name is not null and length(v_name) > 60 then
    perform earth.raise('invalid_input', 'name is longer than 60 characters');
  end if;
  perform earth.assert_avatar_media(v_avatar, v_me);

  update public.groups g
     set name = case when v_name is null then g.name else nullif(v_name, '') end,
         avatar_media_id = coalesce(v_avatar, g.avatar_media_id),
         last_activity_at = now()
   where g.id = v_group.id;

  return earth.group_json(v_group.id, v_me);
end
$$;

create or replace function public.group_invite_create(
  group_id uuid,
  expires_in_seconds integer default null,
  max_uses integer default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_group public.groups := earth.assert_group(group_id);
  v_role public.group_member_role := earth.group_role(v_group.id, v_me);
  v_seconds integer := expires_in_seconds;
  v_max integer := max_uses;
  v_expires timestamptz;
  v_token text;
  v_invite public.group_invites%rowtype;
begin
  if v_role is null then
    perform earth.raise('not_a_member');
  end if;
  if v_group.status <> 'active' then
    perform earth.raise('group_not_found');
  end if;
  perform earth.rate_limit_for_caller('group_invite_create', 20, 3600);

  if v_role not in ('owner', 'moderator') and (v_seconds is not null or v_max is not null) then
    perform earth.raise('not_a_moderator');
  end if;
  if v_seconds is not null and (v_seconds < 0 or v_seconds > 30 * 86400) then
    perform earth.raise('invalid_input', 'expires_in_seconds must be between 0 (never) and 30 days');
  end if;
  if v_max is not null and (v_max < 1 or v_max > 1000) then
    perform earth.raise('invalid_input', 'max_uses must be between 1 and 1000');
  end if;

  v_expires := case
                 when v_seconds is null then now() + interval '30 days'
                 when v_seconds = 0 then null
                 else now() + make_interval(secs => v_seconds)
               end;
  v_token := earth.random_token();

  insert into public.group_invites (group_id, created_by, token_hash, expires_at, max_uses)
  values (v_group.id, v_me, earth.sha256_hex(v_token), v_expires, v_max)
  returning * into v_invite;

  return jsonb_build_object(
    'token', v_token,
    'url', rtrim(coalesce(earth.setting('web_origin'), 'https://earth.social'), '/') || '/g/' || v_token,
    'expiresAt', to_jsonb(v_invite.expires_at),
    'inviteId', v_invite.id,
    'groupId', v_group.id
  );
end
$$;

create or replace function public.group_invite_revoke(invite_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_invite public.group_invites%rowtype;
begin
  perform earth.rate_limit_for_caller('group_invite_revoke', 60, 3600);
  select * into v_invite from public.group_invites gi where gi.id = invite_id;
  if not found then
    perform earth.raise('invite_invalid');
  end if;
  if v_invite.created_by <> v_me and not earth.is_group_moderator(v_invite.group_id, v_me) then
    if earth.is_group_member(v_invite.group_id, v_me) then
      perform earth.raise('not_a_moderator');
    end if;
    perform earth.raise('not_a_member');
  end if;

  update public.group_invites gi
     set status = 'revoked', revoked_at = coalesce(gi.revoked_at, now())
   where gi.id = v_invite.id
  returning * into v_invite;

  perform earth.audit('group_invite_revoke', 'group', v_invite.group_id, jsonb_build_object('inviteId', v_invite.id));
  return jsonb_build_object('id', v_invite.id, 'groupId', v_invite.group_id, 'status', v_invite.status, 'revokedAt', to_jsonb(v_invite.revoked_at));
end
$$;

create or replace function public.group_invite_preview(token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_viewer uuid := earth.current_human();
  v_invite public.group_invites%rowtype;
  v_group public.groups%rowtype;
  v_samples jsonb;
begin
  perform earth.rate_limit_for_caller('group_invite_preview', 60, 60);
  if token is null or token = '' then
    perform earth.raise('invite_invalid');
  end if;
  select * into v_invite from public.group_invites gi where gi.token_hash = earth.sha256_hex(token);
  if not found then
    perform earth.raise('invite_invalid');
  end if;
  select * into v_group from public.groups g where g.id = v_invite.group_id;

  -- Only members whose profile is public, or friends of a Human viewer; never across a block.
  select coalesce(jsonb_agg(earth.person_ref_json(gm.human_id) order by gm.joined_at, gm.human_id), '[]'::jsonb)
    into v_samples
    from (
      select gm.human_id, gm.joined_at
        from public.group_members gm
        join public.humans h on h.id = gm.human_id and h.status = 'active'
        join public.public_identities p on p.human_id = gm.human_id
       where gm.group_id = v_group.id
         and gm.status = 'active'
         and gm.human_id is distinct from v_viewer
         and not earth.is_blocked_either(v_viewer, gm.human_id)
         and (p.profile_visibility = 'public' or earth.are_friends(v_viewer, gm.human_id))
       order by gm.joined_at, gm.human_id
       limit 5
    ) gm;

  return jsonb_build_object(
    'groupName', v_group.name,
    'memberCount', v_group.member_count,
    'sampleMembers', v_samples,
    'alreadyMember', v_viewer is not null and earth.is_group_member(v_group.id, v_viewer),
    'expired', earth.group_invite_usability(v_invite) <> 'ok' or v_group.status <> 'active'
  );
end
$$;

create or replace function public.group_invite_join(token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_group_id uuid;
  v_conversation_id uuid;
  v_already boolean;
  v_second boolean;
begin
  perform earth.rate_limit_for_caller('group_invite_join', 10, 600);
  if token is null or token = '' then
    perform earth.raise('invite_invalid');
  end if;
  select * into v_group_id, v_conversation_id, v_already, v_second
    from earth.group_invite_join_internal(v_me, earth.sha256_hex(token));
  return jsonb_build_object(
    'groupId', v_group_id,
    'conversationId', v_conversation_id,
    'alreadyMember', v_already,
    'isSecondGroup', v_second
  );
end
$$;

create or replace function public.group_leave(group_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_group public.groups := earth.assert_group(group_id);
  v_role public.group_member_role := earth.group_role(v_group.id, v_me);
  v_new_owner uuid;
  v_archived boolean := false;
begin
  perform earth.rate_limit_for_caller('group_leave', 60, 3600);
  if v_role is null then
    perform earth.raise('not_a_member');
  end if;

  update public.group_members gm
     set status = 'left', left_at = now(), role = 'member'
   where gm.group_id = v_group.id and gm.human_id = v_me;

  delete from public.conversation_members cm
   where cm.human_id = v_me
     and cm.conversation_id in (select c.id from public.conversations c where c.group_id = v_group.id);

  if v_role = 'owner' then
    select gm.human_id into v_new_owner
      from public.group_members gm
     where gm.group_id = v_group.id and gm.status = 'active'
     order by (gm.role = 'moderator') desc, gm.joined_at, gm.human_id
     limit 1;
    if v_new_owner is not null then
      update public.group_members gm set role = 'owner'
       where gm.group_id = v_group.id and gm.human_id = v_new_owner;
    end if;
  end if;

  if not exists (select 1 from public.group_members gm where gm.group_id = v_group.id and gm.status = 'active') then
    update public.groups g set status = 'archived' where g.id = v_group.id;
    v_archived := true;
  end if;

  return jsonb_build_object('groupId', v_group.id, 'left', true, 'newOwnerHumanId', v_new_owner, 'archived', v_archived);
end
$$;

create or replace function public.group_member_remove(group_id uuid, human_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_group public.groups := earth.assert_group(group_id);
  v_target uuid := human_id;
  v_role public.group_member_role := earth.group_role(v_group.id, v_me);
  v_target_role public.group_member_role;
begin
  perform earth.rate_limit_for_caller('group_member_remove', 60, 3600);
  if v_role is null then
    perform earth.raise('not_a_member');
  end if;
  if v_role not in ('owner', 'moderator') then
    perform earth.raise('not_a_moderator');
  end if;
  if v_target is null or v_target = v_me then
    perform earth.raise('invalid_input', 'use group_leave to leave a group');
  end if;
  v_target_role := earth.group_role(v_group.id, v_target);
  if v_target_role is null then
    perform earth.raise('not_a_member');
  end if;
  if v_target_role = 'owner' or (v_target_role = 'moderator' and v_role <> 'owner') then
    perform earth.raise('forbidden');
  end if;

  update public.group_members gm
     set status = 'removed', left_at = now(), removed_by_human_id = v_me
   where gm.group_id = v_group.id and gm.human_id = v_target;

  delete from public.conversation_members cm
   where cm.human_id = v_target
     and cm.conversation_id in (select c.id from public.conversations c where c.group_id = v_group.id);

  perform earth.audit('group_member_remove', 'group', v_group.id, jsonb_build_object('humanId', v_target));
  return jsonb_build_object('groupId', v_group.id, 'humanId', v_target, 'status', 'removed');
end
$$;

create or replace function public.group_member_set_role(group_id uuid, human_id uuid, role public.group_member_role)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_group public.groups := earth.assert_group(group_id);
  v_target uuid := human_id;
  v_new_role public.group_member_role := role;
  v_role public.group_member_role := earth.group_role(v_group.id, v_me);
  v_target_role public.group_member_role;
begin
  perform earth.rate_limit_for_caller('group_member_set_role', 60, 3600);
  if v_role is null then
    perform earth.raise('not_a_member');
  end if;
  if v_role = 'member' then
    perform earth.raise('not_a_moderator');
  end if;
  if v_role <> 'owner' then
    perform earth.raise('forbidden');
  end if;
  if v_new_role is null or v_new_role not in ('moderator', 'member') then
    perform earth.raise('invalid_input', 'role must be moderator or member');
  end if;
  if v_target is null or v_target = v_me then
    perform earth.raise('invalid_input', 'an owner cannot change their own role');
  end if;
  v_target_role := earth.group_role(v_group.id, v_target);
  if v_target_role is null then
    perform earth.raise('not_a_member');
  end if;

  update public.group_members gm set role = v_new_role
   where gm.group_id = v_group.id and gm.human_id = v_target;

  perform earth.audit('group_member_set_role', 'group', v_group.id, jsonb_build_object('humanId', v_target, 'role', v_new_role));
  return earth.group_member_json(v_group.id, v_target, v_me);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Conversation RPCs (membership; messages come with 02xx)
-- ---------------------------------------------------------------------------------------------------

create or replace function public.conversation_direct_get_or_create(other_human_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_other uuid := other_human_id;
  v_key text;
  v_id uuid;
begin
  if v_other is null or v_other = v_me then
    perform earth.raise('invalid_input', 'other_human_id must be another Human');
  end if;
  perform earth.assert_active_human(v_other);
  perform earth.rate_limit_for_caller('conversation_create', 60, 3600);
  if earth.is_blocked_either(v_me, v_other) then
    perform earth.raise('blocked');
  end if;

  v_key := earth.direct_key(v_me, v_other);
  insert into public.conversations (type, direct_key)
  values ('direct', v_key)
  on conflict on constraint conversations_direct_key_key do nothing
  returning id into v_id;
  if v_id is null then
    select c.id into v_id from public.conversations c where c.direct_key = v_key;
  end if;

  insert into public.conversation_members (conversation_id, human_id)
  values (v_id, v_me), (v_id, v_other)
  on conflict on constraint conversation_members_pkey do nothing;

  return earth.conversation_summary_json(v_id, v_me);
end
$$;

create or replace function public.conversation_group_create(human_ids uuid[])
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_others uuid[];
  v_other uuid;
  v_group_id uuid;
  v_conversation_id uuid;
begin
  perform earth.rate_limit_for_caller('conversation_create', 60, 3600);
  select coalesce(array_agg(distinct h), '{}'::uuid[]) into v_others
    from unnest(coalesce(human_ids, '{}'::uuid[])) as h
   where h is not null and h <> v_me;
  if coalesce(array_length(v_others, 1), 0) < 2 then
    perform earth.raise('invalid_input', 'a group conversation needs at least two other Humans');
  end if;
  if array_length(v_others, 1) > 50 then
    perform earth.raise('invalid_input', 'at most 50 Humans');
  end if;
  foreach v_other in array v_others loop
    perform earth.assert_active_human(v_other);
    if earth.is_blocked_either(v_me, v_other) then
      perform earth.raise('blocked');
    end if;
  end loop;

  select * into v_group_id, v_conversation_id from earth.group_create_internal(v_me, null, 'temporary');

  insert into public.group_members (group_id, human_id, role, status)
  select v_group_id, h, 'member', 'active' from unnest(v_others) as h;
  insert into public.conversation_members (conversation_id, human_id)
  select v_conversation_id, h from unnest(v_others) as h;

  return earth.conversation_summary_json(v_conversation_id, v_me);
end
$$;

create or replace function public.conversations_list(cursor timestamptz default null, "limit" integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_cursor timestamptz := cursor;
  v_limit integer := least(greatest(coalesce("limit", 30), 1), 100);
  v_items jsonb;
  v_next timestamptz;
  v_count integer;
begin
  with page as (
    select c.id, coalesce(c.last_message_at, c.created_at) as sort_at
      from public.conversations c
      join public.conversation_members cm on cm.conversation_id = c.id and cm.human_id = v_me
     where (v_cursor is null or coalesce(c.last_message_at, c.created_at) < v_cursor)
       and not (c.type = 'direct' and earth.is_blocked_either(v_me, earth.direct_other_member(c.id, v_me)))
     order by coalesce(c.last_message_at, c.created_at) desc, c.id
     limit v_limit
  )
  select coalesce(jsonb_agg(earth.conversation_summary_json(page.id, v_me) order by page.sort_at desc, page.id), '[]'::jsonb),
         min(page.sort_at),
         count(*)
    into v_items, v_next, v_count
    from page;

  return jsonb_build_object(
    'conversations', v_items,
    'nextCursor', case when v_count = v_limit then to_jsonb(v_next) else null end
  );
end
$$;

create or replace function public.conversation_get(conversation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_id uuid := conversation_id;
  v_type public.conversation_type;
  v_members jsonb;
begin
  if not earth.is_conversation_member(v_id, v_me) then
    perform earth.raise('conversation_not_found');
  end if;
  select c.type into v_type from public.conversations c where c.id = v_id;
  if v_type = 'direct' and earth.is_blocked_either(v_me, earth.direct_other_member(v_id, v_me)) then
    perform earth.raise('blocked');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'humanId', cm.human_id,
           'displayName', p.display_name,
           'handle', p.handle,
           'avatarUrl', earth.public_media_url(p.avatar_media_id),
           'joinedAt', to_jsonb(cm.joined_at),
           'lastReadMessageId', cm.last_read_message_id
         ) order by cm.joined_at, p.display_name, cm.human_id), '[]'::jsonb)
    into v_members
    from public.conversation_members cm
    join public.humans h on h.id = cm.human_id and h.status = 'active'
    join public.public_identities p on p.human_id = cm.human_id
   where cm.conversation_id = v_id;

  return earth.conversation_summary_json(v_id, v_me) || jsonb_build_object('members', v_members);
end
$$;

create or replace function public.conversation_set_prefs(
  conversation_id uuid,
  mute_state text default null,
  notification_level text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_id uuid := conversation_id;
  v_mute text := nullif(btrim(coalesce(mute_state, '')), '');
  v_level text := nullif(btrim(coalesce(notification_level, '')), '');
  v_row public.conversation_members%rowtype;
begin
  perform earth.rate_limit_for_caller('conversation_set_prefs', 120, 3600);
  if not earth.is_conversation_member(v_id, v_me) then
    perform earth.raise('conversation_not_found');
  end if;
  if v_mute is not null and v_mute not in ('none', 'muted') then
    perform earth.raise('invalid_input', 'mute_state must be none or muted');
  end if;
  if v_level is not null and v_level not in ('all', 'mentions', 'none') then
    perform earth.raise('invalid_input', 'notification_level must be all, mentions or none');
  end if;

  update public.conversation_members cm
     set mute_state = coalesce(v_mute, cm.mute_state),
         notification_level = coalesce(v_level, cm.notification_level)
   where cm.conversation_id = v_id and cm.human_id = v_me
  returning * into v_row;

  return jsonb_build_object(
    'conversationId', v_row.conversation_id,
    'muteState', v_row.mute_state,
    'notificationLevel', v_row.notification_level
  );
end
$$;

create or replace function public.conversation_read_receipts(conversation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_id uuid := conversation_id;
begin
  if not earth.is_conversation_member(v_id, v_me) then
    perform earth.raise('conversation_not_found');
  end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
             'humanId', cm.human_id,
             'lastReadMessageId', cm.last_read_message_id,
             'lastReadAt', to_jsonb(cm.last_read_at)
           ) order by cm.joined_at, cm.human_id), '[]'::jsonb)
      from public.conversation_members cm
      join public.humans h on h.id = cm.human_id and h.status = 'active'
     where cm.conversation_id = v_id
  );
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------

revoke execute on function public.group_create(text) from public;
revoke execute on function public.group_get(uuid) from public;
revoke execute on function public.group_update(uuid, text, uuid) from public;
revoke execute on function public.group_invite_create(uuid, integer, integer) from public;
revoke execute on function public.group_invite_revoke(uuid) from public;
revoke execute on function public.group_invite_preview(text) from public;
revoke execute on function public.group_invite_join(text) from public;
revoke execute on function public.group_leave(uuid) from public;
revoke execute on function public.group_member_remove(uuid, uuid) from public;
revoke execute on function public.group_member_set_role(uuid, uuid, public.group_member_role) from public;
revoke execute on function public.conversation_direct_get_or_create(uuid) from public;
revoke execute on function public.conversation_group_create(uuid[]) from public;
revoke execute on function public.conversations_list(timestamptz, integer) from public;
revoke execute on function public.conversation_get(uuid) from public;
revoke execute on function public.conversation_set_prefs(uuid, text, text) from public;
revoke execute on function public.conversation_read_receipts(uuid) from public;

grant execute on function public.group_create(text) to anon, authenticated, service_role;
grant execute on function public.group_get(uuid) to anon, authenticated, service_role;
grant execute on function public.group_update(uuid, text, uuid) to anon, authenticated, service_role;
grant execute on function public.group_invite_create(uuid, integer, integer) to anon, authenticated, service_role;
grant execute on function public.group_invite_revoke(uuid) to anon, authenticated, service_role;
grant execute on function public.group_invite_preview(text) to anon, authenticated, service_role;
grant execute on function public.group_invite_join(text) to anon, authenticated, service_role;
grant execute on function public.group_leave(uuid) to anon, authenticated, service_role;
grant execute on function public.group_member_remove(uuid, uuid) to anon, authenticated, service_role;
grant execute on function public.group_member_set_role(uuid, uuid, public.group_member_role) to anon, authenticated, service_role;
grant execute on function public.conversation_direct_get_or_create(uuid) to anon, authenticated, service_role;
grant execute on function public.conversation_group_create(uuid[]) to anon, authenticated, service_role;
grant execute on function public.conversations_list(timestamptz, integer) to anon, authenticated, service_role;
grant execute on function public.conversation_get(uuid) to anon, authenticated, service_role;
grant execute on function public.conversation_set_prefs(uuid, text, text) to anon, authenticated, service_role;
grant execute on function public.conversation_read_receipts(uuid) to anon, authenticated, service_role;

-- Internals that mutate state stay owner/service only.
revoke execute on function earth.group_create_internal(uuid, text, public.group_kind) from public, anon, authenticated;
revoke execute on function earth.group_invite_join_internal(uuid, text) from public, anon, authenticated;
revoke execute on function earth.system_message(uuid, uuid, text) from public, anon, authenticated;
