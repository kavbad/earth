-- 0160 — caller helpers and identity JSON (ARCHITECTURE §4; DB_API §1 "Helper functions").
--
-- `earth.current_human_id()` / `earth.current_human()` / `earth.current_role_kind()` are the single
-- source RPCs and policies branch on. They are `security definer` so a policy evaluated as
-- anon/authenticated can read `humans` without recursing into its own RLS. Executable by the API
-- roles (0002 default privileges for schema earth) because policies call them; none has side effects.

-- The Human linked to auth.uid(), whatever its status (null for visitors, guests and unclaimed users).
create or replace function earth.current_human_id()
returns uuid
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select h.id
    from public.humans h
   where h.auth_user_id = auth.uid()
     and auth.uid() is not null
   limit 1
$$;

-- The caller's Human only when it is active (member features).
create or replace function earth.current_human()
returns uuid
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select h.id
    from public.humans h
   where h.auth_user_id = auth.uid()
     and auth.uid() is not null
     and h.status = 'active'
   limit 1
$$;

-- A Human's status without going through RLS (policies use it for the caller's own row).
create or replace function earth.human_status(human_id uuid)
returns public.human_status
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select h.status from public.humans h where h.id = human_status.human_id
$$;

-- 'visitor' | 'guest' | 'claiming' | 'human' | 'service' (ARCHITECTURE §4). A real credential without a
-- Human yet, or with a pending one, is `claiming`; restricted/suspended Humans are still `human`
-- (earth.assert_human raises `human_not_active` for them).
create or replace function earth.current_role_kind()
returns text
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_uid uuid;
  v_status public.human_status;
begin
  if earth.is_service_role() then
    return 'service';
  end if;
  v_uid := auth.uid();
  if v_uid is null then
    return 'visitor';
  end if;
  if earth.is_anonymous_jwt() then
    return 'guest';
  end if;
  select h.status into v_status from public.humans h where h.auth_user_id = v_uid limit 1;
  if v_status in ('active', 'restricted', 'suspended') then
    return 'human';
  end if;
  return 'claiming';
end
$$;

-- The active Human of the caller, or raises: `not_authenticated` (visitor), `not_a_human` (guest,
-- unclaimed or pending credential, service), `human_not_active` (restricted/suspended/deleted).
create or replace function earth.assert_human()
returns uuid
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_id uuid;
  v_status public.human_status;
begin
  if v_kind = 'visitor' then
    perform earth.raise('not_authenticated');
  end if;
  if v_kind in ('guest', 'claiming', 'service') then
    perform earth.raise('not_a_human');
  end if;
  select h.id, h.status into v_id, v_status
    from public.humans h
   where h.auth_user_id = auth.uid()
   limit 1;
  if v_id is null then
    perform earth.raise('not_a_human');
  end if;
  if v_status <> 'active' then
    perform earth.raise('human_not_active');
  end if;
  return v_id;
end
$$;

-- The caller's pending Human (claim flow), or raises: `not_authenticated`, `guest_not_allowed`,
-- `claim_not_pending` (no Human yet, or already claimed).
create or replace function earth.assert_claiming()
returns uuid
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_id uuid;
begin
  if v_kind = 'visitor' then
    perform earth.raise('not_authenticated');
  end if;
  if v_kind = 'guest' then
    perform earth.raise('guest_not_allowed');
  end if;
  if v_kind = 'service' then
    perform earth.raise('forbidden');
  end if;
  select h.id into v_id
    from public.humans h
   where h.auth_user_id = auth.uid() and h.status = 'pending'
   limit 1;
  if v_id is null then
    perform earth.raise('claim_not_pending');
  end if;
  return v_id;
end
$$;

-- Public URL of a media object: only the `avatars` bucket is public, and only once
-- app_settings.public_storage_base_url is configured (null otherwise, so DTOs stay valid).
create or replace function earth.public_media_url(media_id uuid)
returns text
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select case
           when m.bucket = 'avatars' and coalesce(earth.setting('public_storage_base_url'), '') <> ''
           then rtrim(earth.setting('public_storage_base_url'), '/') || '/' || m.bucket || '/' || m.storage_key
           else null
         end
    from public.media_objects m
   where m.id = public_media_url.media_id
$$;

-- Whether `viewer` (an active Human id, or null for visitors/guests/claiming) may see `target`'s
-- public identity: active Humans only; public → anyone, limited → signed-in Humans, hidden → friends;
-- never across a block; fixtures are hidden from visitors in production (DB_API §10).
create or replace function earth.identity_visible_to(target uuid, viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select exists (
    select 1
      from public.humans h
      join public.public_identities p on p.human_id = h.id
     where h.id = target
       and (
         h.id = viewer
         or (
           h.status = 'active'
           and not earth.is_blocked_either(h.id, viewer)
           and not (h.is_fixture and viewer is null and earth.setting('environment') = 'production')
           and (
             p.profile_visibility = 'public'
             or (p.profile_visibility = 'limited' and viewer is not null)
             or earth.are_friends(h.id, viewer)
           )
         )
       )
  )
$$;

-- Home city name when the Human shares it publicly.
create or replace function earth.identity_city_name(human_id uuid)
returns text
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select a.name
    from public.public_identities p
    join public.areas a on a.id = p.home_city_area_id
   where p.human_id = identity_city_name.human_id
     and p.public_city_visibility
$$;

-- `PublicIdentityDto` (a superset of DB_API's `{humanId, displayName, handle, avatarUrl}`; also
-- carries bio, cityName and profileVisibility). Null when the Human has no identity yet.
create or replace function earth.identity_json(human_id uuid)
returns jsonb
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
    'humanId', p.human_id,
    'displayName', p.display_name,
    'handle', p.handle,
    'avatarUrl', earth.public_media_url(p.avatar_media_id),
    'bio', p.bio,
    'cityName', earth.identity_city_name(p.human_id),
    'profileVisibility', p.profile_visibility
  )
  from public.public_identities p
  where p.human_id = identity_json.human_id
$$;

-- `PersonRefDto` (`{displayName, avatarUrl}`), for samples and participant lists.
create or replace function earth.person_ref_json(human_id uuid)
returns jsonb
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
    'displayName', p.display_name,
    'avatarUrl', earth.public_media_url(p.avatar_media_id)
  )
  from public.public_identities p
  where p.human_id = person_ref_json.human_id
$$;

create or replace function earth.display_name_of(human_id uuid)
returns text
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select p.display_name from public.public_identities p where p.human_id = display_name_of.human_id
$$;

-- Active membership in an active group.
create or replace function earth.is_group_member(group_id uuid, human_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select group_id is not null and human_id is not null and exists (
    select 1
      from public.group_members gm
     where gm.group_id = is_group_member.group_id
       and gm.human_id = is_group_member.human_id
       and gm.status = 'active'
  )
$$;

-- The caller's active role in the group ('owner' | 'moderator' | 'member'), or null.
create or replace function earth.group_role(group_id uuid, human_id uuid)
returns public.group_member_role
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select gm.role
    from public.group_members gm
   where gm.group_id = group_role.group_id
     and gm.human_id = group_role.human_id
     and gm.status = 'active'
$$;

create or replace function earth.is_group_moderator(group_id uuid, human_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select coalesce(earth.group_role(group_id, human_id) in ('owner', 'moderator'), false)
$$;

create or replace function earth.is_conversation_member(conversation_id uuid, human_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select conversation_id is not null and human_id is not null and exists (
    select 1
      from public.conversation_members cm
     where cm.conversation_id = is_conversation_member.conversation_id
       and cm.human_id = is_conversation_member.human_id
  )
$$;

-- Sorted-pair key of a direct conversation (`conversations.direct_key`).
create or replace function earth.direct_key(a uuid, b uuid)
returns text
language sql
immutable
strict
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select least(a, b)::text || ':' || greatest(a, b)::text
$$;

-- `ActiveRoomRefDto` for a room pointer, once rooms exist (03xx); null until then or when no room.
create or replace function earth.active_room_ref_json(room_id uuid)
returns jsonb
language plpgsql
stable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_count integer;
begin
  if room_id is null or to_regclass('public.rooms') is null then
    return null;
  end if;
  execute 'select r.active_participant_count from public.rooms r where r.id = $1 and r.status in (''starting'', ''active'')'
    into v_count using room_id;
  if v_count is null then
    return null;
  end if;
  return jsonb_build_object('roomId', room_id, 'participantCount', greatest(v_count, 0));
end
$$;
