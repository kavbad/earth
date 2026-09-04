-- 0180 — identity, claim flow and social RPCs (DB_API §1 "RPCs"; spec §16–21, §44–49, §77–80).
--
-- Every RPC: security definer, fixed search_path, caller validated through earth.current_role_kind()
-- / earth.assert_human() / earth.assert_claiming(), mutations rate limited with
-- earth.rate_limit_for_caller, errors only through earth.raise('<code>'), jsonb results shaped like
-- packages/domain/src/dto. Inside bodies every column is table-qualified and every local is `v_`-
-- prefixed so contract parameter names (`target_human_id`, ...) never collide with columns.
-- earth.notify (0190), earth.audit (0195) and the group internals (0185) are resolved at call time.

-- ---------------------------------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------------------------------

-- Lowercases, trims and strips a leading '@' (mirror of normalizeHandle's cheap part).
create or replace function earth.normalize_handle(p_handle text)
returns text
language sql
immutable
set search_path = public, earth, private, pg_temp
as $$
  select lower(regexp_replace(btrim(coalesce(p_handle, '')), '^@+', ''))
$$;

create or replace function earth.is_valid_handle(p_handle text)
returns boolean
language sql
immutable
set search_path = public, earth, private, pg_temp
as $$
  select coalesce(p_handle ~ '^[a-z][a-z0-9_]{2,23}$', false)
$$;

-- Case-insensitive uniqueness, ignoring the Human editing their own handle.
create or replace function earth.handle_taken(p_handle text, p_exclude_human_id uuid default null)
returns boolean
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select exists (
    select 1 from public.public_identities p
     where lower(p.handle) = lower(p_handle)
       and (p_exclude_human_id is null or p.human_id <> p_exclude_human_id)
  )
$$;

-- `ClaimStateDto` for a Human in any status (`claimed` once active).
create or replace function earth.claim_state_json(p_human_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_human public.humans%rowtype;
  v_identity jsonb;
  v_session text;
  v_status text;
  v_approved boolean;
begin
  select * into v_human from public.humans h where h.id = p_human_id;
  if not found then
    return null;
  end if;
  select jsonb_build_object(
           'displayName', p.display_name,
           'handle', p.handle,
           'avatarUrl', earth.public_media_url(p.avatar_media_id)
         )
    into v_identity
    from public.public_identities p
   where p.human_id = v_human.id;
  select hp.provider_reference into v_session from public.human_passes hp where hp.human_id = v_human.id;
  v_approved := exists (
    select 1 from public.identity_reviews r where r.human_id = v_human.id and r.status = 'approved'
  );
  if v_human.status <> 'pending' then
    v_status := 'claimed';
  elsif v_identity is null then
    v_status := 'started';
  elsif v_human.human_pass_status = 'verified' or v_approved then
    v_status := 'verified';
  elsif v_human.human_pass_status in ('verifying', 'review_required', 'rejected') then
    v_status := 'verifying';
  else
    v_status := 'identity_set';
  end if;
  return jsonb_build_object(
    'status', v_status,
    'intent', v_human.claim_intent,
    'groupLabel', v_human.claim_group_label,
    'identity', v_identity,
    'verification', jsonb_strip_nulls(jsonb_build_object(
      'status', v_human.human_pass_status,
      'sessionId', nullif(v_session, '')
    )),
    'humanId', v_human.id
  );
end
$$;

-- `HumanContextDto` (all null when the Human has no context row yet).
create or replace function earth.human_context_json(p_human_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
    'currentAreaId', c.current_area_id,
    'currentAreaName', earth.area_name(c.current_area_id),
    'currentCityId', c.current_city_id,
    'currentCityName', earth.area_name(c.current_city_id),
    'homeCityId', c.home_city_id
  )
  from (
    select hc.current_area_id, hc.current_city_id, hc.home_city_id
      from public.human_context hc
     where hc.human_id = p_human_id
    union all
    select null::uuid, null::uuid, null::uuid
     where not exists (select 1 from public.human_context hc2 where hc2.human_id = p_human_id)
  ) c
$$;

-- Friend request state from `p_viewer`'s side ('none' | 'sent' | 'received'; friends → 'none').
create or replace function earth.friend_request_state(p_viewer uuid, p_other uuid)
returns text
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select case
           when earth.are_friends(p_viewer, p_other) then 'none'
           when exists (
             select 1 from public.relationships r
              where r.type = 'friend_pending' and r.source_human_id = p_viewer and r.target_human_id = p_other
           ) then 'sent'
           when exists (
             select 1 from public.relationships r
              where r.type = 'friend_pending' and r.source_human_id = p_other and r.target_human_id = p_viewer
           ) then 'received'
           else 'none'
         end
$$;

-- `RelationshipChangeDto` between the caller and another Human.
create or replace function earth.relationship_change_json(p_viewer uuid, p_other uuid)
returns jsonb
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
    'humanId', p_other,
    'isFriend', earth.are_friends(p_viewer, p_other),
    'friendRequest', earth.friend_request_state(p_viewer, p_other),
    'isFollowing', earth.is_following(p_viewer, p_other),
    'updatedAt', to_jsonb(now())
  )
$$;

-- `RelationshipFlagsDto` (isBlocked = blocked by the viewer only; being blocked is never revealed).
create or replace function earth.relationship_flags_json(p_viewer uuid, p_other uuid)
returns jsonb
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
    'isSelf', p_viewer is not null and p_viewer = p_other,
    'isFriend', earth.are_friends(p_viewer, p_other),
    'friendRequest', earth.friend_request_state(p_viewer, p_other),
    'isFollowing', earth.is_following(p_viewer, p_other),
    'isFollowedBy', earth.is_following(p_other, p_viewer),
    'isBlocked', earth.has_blocked(p_viewer, p_other)
  )
$$;

-- Raises `not_visible` unless `p_human_id` is an active Human.
create or replace function earth.assert_active_human(p_human_id uuid)
returns void
language plpgsql
stable
set search_path = public, earth, private, pg_temp
as $$
begin
  if p_human_id is null
     or not exists (select 1 from public.humans h where h.id = p_human_id and h.status = 'active') then
    perform earth.raise('not_visible');
  end if;
end
$$;

-- A media object usable as an avatar by `p_human_id` (own object in the `avatars` bucket).
create or replace function earth.assert_avatar_media(p_media_id uuid, p_human_id uuid)
returns void
language plpgsql
stable
set search_path = public, earth, private, pg_temp
as $$
begin
  if p_media_id is null then
    return;
  end if;
  if not exists (
    select 1 from public.media_objects m
     where m.id = p_media_id and m.owner_human_id = p_human_id and m.bucket = 'avatars'
  ) then
    perform earth.raise('invalid_input', 'avatar_media_id must be an own object in the avatars bucket');
  end if;
end
$$;

-- Raises `not_authenticated` / `guest_not_allowed` / `forbidden` for callers that cannot be in a
-- claim flow; returns the caller's auth user id.
create or replace function earth.assert_real_credential()
returns uuid
language plpgsql
stable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
begin
  if v_kind = 'visitor' then
    perform earth.raise('not_authenticated');
  elsif v_kind = 'guest' then
    perform earth.raise('guest_not_allowed');
  elsif v_kind = 'service' then
    perform earth.raise('forbidden');
  end if;
  return auth.uid();
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Claim flow (spec §44–48; DB_API §1)
-- ---------------------------------------------------------------------------------------------------

create or replace function public.claim_start(
  intent text default null,
  group_label text default null,
  invite_token text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_uid uuid := earth.assert_real_credential();
  v_intent text := intent;
  v_label text;
  v_hash text;
  v_human public.humans%rowtype;
  v_invite public.group_invites%rowtype;
  v_claims jsonb;
  v_email text;
  v_phone text;
begin
  perform earth.rate_limit_for_caller('claim_start', 20, 3600);

  select * into v_human from public.humans h where h.auth_user_id = v_uid limit 1;
  if found and v_human.status <> 'pending' then
    perform earth.raise('duplicate_human');
  end if;

  if v_intent is null then
    if earth.flag('GROUP_ANCHORED_CLAIM_REQUIRED') then
      perform earth.raise('invalid_input', 'intent is required while GROUP_ANCHORED_CLAIM_REQUIRED is on');
    end if;
  elsif v_intent not in ('start_group', 'join_group') then
    perform earth.raise('invalid_input', 'intent must be start_group or join_group');
  end if;

  v_label := nullif(btrim(coalesce(group_label, '')), '');
  if v_label is not null and length(v_label) > 60 then
    perform earth.raise('invalid_input', 'group_label is longer than 60 characters');
  end if;

  if v_intent = 'join_group' then
    if invite_token is null or invite_token = '' then
      perform earth.raise('invalid_input', 'join_group requires invite_token');
    end if;
    v_hash := earth.sha256_hex(invite_token);
    v_invite := earth.assert_group_invite_usable(v_hash);
    select g.name into v_label from public.groups g where g.id = v_invite.group_id;
  else
    v_hash := null;
  end if;

  if v_human.id is null then
    insert into public.humans (status, auth_user_id, claim_intent, claim_group_label, claim_invite_token_hash)
    values ('pending', v_uid, v_intent, v_label, v_hash)
    returning * into v_human;

    insert into public.auth_identities (human_id, provider, provider_subject, verified_at)
    values (v_human.id, 'supabase', v_uid::text, now())
    on conflict on constraint auth_identities_provider_subject_key do nothing;

    -- Method rows for portability (ARCHITECTURE §4): whatever the credential carries.
    v_claims := earth.jwt_claims();
    v_email := nullif(lower(btrim(coalesce(v_claims ->> 'email', ''))), '');
    v_phone := nullif(btrim(coalesce(v_claims ->> 'phone', '')), '');
    if v_email is not null then
      insert into public.auth_identities (human_id, provider, provider_subject, verified_at)
      values (v_human.id, 'email', v_email, now())
      on conflict on constraint auth_identities_provider_subject_key do nothing;
    end if;
    if v_phone is not null then
      insert into public.auth_identities (human_id, provider, provider_subject, verified_at)
      values (v_human.id, 'phone', v_phone, now())
      on conflict on constraint auth_identities_provider_subject_key do nothing;
    end if;
  else
    update public.humans h
       set claim_intent = v_intent,
           claim_group_label = v_label,
           claim_invite_token_hash = v_hash
     where h.id = v_human.id;
  end if;

  return earth.claim_state_json(v_human.id);
end
$$;

create or replace function public.claim_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_uid uuid := earth.assert_real_credential();
  v_id uuid;
begin
  select h.id into v_id from public.humans h where h.auth_user_id = v_uid limit 1;
  if v_id is null then
    perform earth.raise('claim_not_pending');
  end if;
  return earth.claim_state_json(v_id);
end
$$;

create or replace function public.claim_set_identity(
  display_name text,
  handle text,
  avatar_media_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_human uuid := earth.assert_claiming();
  v_name text := btrim(coalesce(display_name, ''));
  v_handle text := earth.normalize_handle(handle);
  v_avatar uuid := avatar_media_id;
begin
  perform earth.rate_limit_for_caller('claim_set_identity', 30, 3600);

  if length(v_name) < 1 or length(v_name) > 40 then
    perform earth.raise('invalid_input', 'display_name must be 1–40 characters');
  end if;
  if not earth.is_valid_handle(v_handle) then
    perform earth.raise('handle_invalid');
  end if;
  if earth.handle_taken(v_handle, v_human) then
    perform earth.raise('handle_taken');
  end if;
  perform earth.assert_avatar_media(v_avatar, v_human);

  begin
    insert into public.public_identities (human_id, display_name, handle, avatar_media_id)
    values (v_human, v_name, v_handle, v_avatar)
    on conflict on constraint public_identities_pkey do update
      set display_name = excluded.display_name,
          handle = excluded.handle,
          avatar_media_id = excluded.avatar_media_id;
  exception
    when unique_violation then
      perform earth.raise('handle_taken');
  end;

  return earth.claim_state_json(v_human);
end
$$;

create or replace function public.claim_verification_begin(provider text default 'mock')
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_human uuid := earth.assert_claiming();
  v_provider text := coalesce(nullif(btrim(provider), ''), 'mock');
  v_pass public.human_passes%rowtype;
begin
  perform earth.rate_limit_for_caller('claim_verification_begin', 10, 3600);

  if v_provider not in ('mock', 'manual_review', 'vendor') then
    perform earth.raise('invalid_input', 'provider must be mock, manual_review or vendor');
  end if;

  select * into v_pass from public.human_passes hp where hp.human_id = v_human;
  if found and v_pass.status = 'verified' then
    return jsonb_build_object('humanPassId', v_pass.id, 'status', v_pass.status);
  end if;

  insert into public.human_passes (human_id, provider, status)
  values (v_human, v_provider, 'verifying')
  on conflict on constraint human_passes_human_id_key do update
    set provider = excluded.provider,
        status = 'verifying',
        provider_reference = null,
        risk_level = null,
        verified_at = null,
        reviewed_at = null
  returning * into v_pass;

  update public.humans h set human_pass_status = 'verifying' where h.id = v_human;

  return jsonb_build_object('humanPassId', v_pass.id, 'status', v_pass.status);
end
$$;

create or replace function public.human_pass_record_result(
  human_id uuid,
  status public.human_pass_status,
  risk_level text default null,
  provider text default null,
  provider_reference text default null,
  metadata jsonb default '{}'::jsonb,
  duplicate_of_human_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_human uuid := human_id;
  v_status public.human_pass_status := status;
  v_risk text := nullif(btrim(coalesce(risk_level, '')), '');
  v_provider text := nullif(btrim(coalesce(provider, '')), '');
  v_reference text := nullif(btrim(coalesce(provider_reference, '')), '');
  v_metadata jsonb := coalesce(metadata, '{}'::jsonb);
  v_duplicate uuid := duplicate_of_human_id;
  v_pass public.human_passes%rowtype;
begin
  if earth.current_role_kind() <> 'service' then
    perform earth.raise('forbidden');
  end if;
  if v_human is null or v_status is null
     or not exists (select 1 from public.humans h where h.id = v_human) then
    perform earth.raise('invalid_input', 'human_id must reference a Human and status is required');
  end if;
  if v_risk is not null and v_risk not in ('low', 'medium', 'high') then
    perform earth.raise('invalid_input', 'risk_level must be low, medium or high');
  end if;
  if v_provider is not null and v_provider not in ('mock', 'manual_review', 'vendor') then
    perform earth.raise('invalid_input', 'provider must be mock, manual_review or vendor');
  end if;
  if jsonb_typeof(v_metadata) <> 'object' then
    perform earth.raise('invalid_input', 'metadata must be a JSON object');
  end if;
  if v_duplicate is not null and (v_duplicate = v_human
     or not exists (select 1 from public.humans h where h.id = v_duplicate)) then
    perform earth.raise('invalid_input', 'duplicate_of_human_id must reference another Human');
  end if;

  select * into v_pass from public.human_passes hp where hp.human_id = v_human;
  insert into public.human_passes (human_id, provider, provider_reference, status, risk_level, verified_at, reviewed_at)
  values (
    v_human,
    coalesce(v_provider, v_pass.provider, 'mock'),
    coalesce(v_reference, v_pass.provider_reference),
    v_status,
    v_risk,
    case when v_status = 'verified' then now() else null end,
    case when v_status in ('review_required', 'rejected') then now() else null end
  )
  on conflict on constraint human_passes_human_id_key do update
    set provider = excluded.provider,
        provider_reference = excluded.provider_reference,
        status = excluded.status,
        risk_level = excluded.risk_level,
        verified_at = excluded.verified_at,
        reviewed_at = excluded.reviewed_at
  returning * into v_pass;

  insert into private.human_pass_metadata (human_pass_id, metadata)
  values (v_pass.id, v_metadata)
  on conflict on constraint human_pass_metadata_pkey do update
    set metadata = excluded.metadata, updated_at = now();

  update public.humans h set human_pass_status = v_status where h.id = v_human;

  if v_status = 'review_required' and v_duplicate is not null
     and not exists (
       select 1 from public.identity_reviews r
        where r.human_id = v_human and r.kind = 'duplicate' and r.status = 'open'
     ) then
    insert into public.identity_reviews (human_id, kind, status, details, duplicate_of_human_id)
    values (v_human, 'duplicate', 'open', jsonb_build_object('duplicateOfHumanId', v_duplicate, 'source', 'human_pass'), v_duplicate);
  end if;

  perform earth.audit(
    'human_pass_record_result', 'human', v_human,
    jsonb_build_object('status', v_status, 'riskLevel', v_risk, 'duplicateOfHumanId', v_duplicate)
  );

  return earth.claim_state_json(v_human);
end
$$;

create or replace function public.identity_review_create(kind text, details jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_uid uuid := earth.assert_real_credential();
  v_human uuid;
  v_kind text := nullif(btrim(coalesce(kind, '')), '');
  v_details jsonb := coalesce(details, '{}'::jsonb);
  v_review public.identity_reviews%rowtype;
begin
  select h.id into v_human from public.humans h where h.auth_user_id = v_uid limit 1;
  if v_human is null then
    perform earth.raise('claim_not_pending');
  end if;
  perform earth.rate_limit_for_caller('identity_review_create', 5, 3600);

  if v_kind is null or v_kind not in ('duplicate', 'inconclusive', 'help', 'safety', 'recovery') then
    perform earth.raise('invalid_input', 'kind must be duplicate, inconclusive, help, safety or recovery');
  end if;
  if jsonb_typeof(v_details) <> 'object' then
    perform earth.raise('invalid_input', 'details must be a JSON object');
  end if;

  insert into public.identity_reviews (human_id, kind, status, details)
  values (v_human, v_kind, 'open', v_details)
  returning * into v_review;

  perform earth.audit('identity_review_create', 'human', v_human, jsonb_build_object('kind', v_kind, 'reviewId', v_review.id));

  return jsonb_build_object(
    'id', v_review.id,
    'humanId', v_review.human_id,
    'kind', v_review.kind,
    'status', v_review.status,
    'createdAt', to_jsonb(v_review.created_at)
  );
end
$$;

create or replace function public.claim_complete()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_human_id uuid := earth.assert_claiming();
  v_human public.humans%rowtype;
  v_verified boolean;
  v_open_review boolean;
  v_group_id uuid;
  v_conversation_id uuid;
  v_already boolean;
  v_second boolean;
begin
  perform earth.rate_limit_for_caller('claim_complete', 10, 3600);

  select * into v_human from public.humans h where h.id = v_human_id for update;
  if v_human.status <> 'pending' then
    perform earth.raise('claim_not_pending');
  end if;
  if not exists (select 1 from public.public_identities p where p.human_id = v_human_id) then
    perform earth.raise('claim_identity_missing');
  end if;
  if exists (
    select 1 from public.identity_reviews r
     where r.human_id = v_human_id and r.kind = 'duplicate' and r.status = 'open'
  ) then
    perform earth.raise('duplicate_human');
  end if;

  v_verified := v_human.human_pass_status = 'verified'
    or exists (select 1 from public.identity_reviews r where r.human_id = v_human_id and r.status = 'approved');
  if not v_verified then
    v_open_review := exists (
      select 1 from public.identity_reviews r where r.human_id = v_human_id and r.status = 'open'
    );
    if v_human.human_pass_status in ('verifying', 'review_required') or v_open_review then
      perform earth.raise('verification_pending');
    end if;
    perform earth.raise('verification_required');
  end if;

  if v_human.claim_intent is null and earth.flag('GROUP_ANCHORED_CLAIM_REQUIRED') then
    perform earth.raise('invalid_input', 'a group intent is required while GROUP_ANCHORED_CLAIM_REQUIRED is on');
  end if;

  update public.humans h
     set status = 'active',
         claimed_at = now(),
         last_active_at = now()
   where h.id = v_human_id;

  if v_human.claim_intent = 'start_group' then
    select * into v_group_id, v_conversation_id
      from earth.group_create_internal(v_human_id, v_human.claim_group_label);
  elsif v_human.claim_intent = 'join_group' then
    if v_human.claim_invite_token_hash is null then
      perform earth.raise('invite_invalid');
    end if;
    select * into v_group_id, v_conversation_id, v_already, v_second
      from earth.group_invite_join_internal(v_human_id, v_human.claim_invite_token_hash);
    update public.humans h set claim_invite_token_hash = null where h.id = v_human_id;
  end if;

  insert into public.human_context (human_id) values (v_human_id)
  on conflict on constraint human_context_pkey do nothing;

  perform earth.audit(
    'claim_complete', 'human', v_human_id,
    jsonb_build_object('intent', v_human.claim_intent, 'groupId', v_group_id, 'conversationId', v_conversation_id)
  );

  return jsonb_build_object(
    'humanId', v_human_id,
    'groupId', v_group_id,
    'conversationId', v_conversation_id
  );
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Profiles and identity
-- ---------------------------------------------------------------------------------------------------

create or replace function public.profile_get(handle text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_viewer uuid := earth.current_human();
  v_self uuid := earth.current_human_id();
  v_handle text := earth.normalize_handle(handle);
  v_target uuid;
begin
  select p.human_id into v_target
    from public.public_identities p
   where lower(p.handle) = v_handle;
  if v_target is null
     or not ((v_self is not null and v_target = v_self) or earth.identity_visible_to(v_target, v_viewer)) then
    perform earth.raise('not_visible');
  end if;

  -- Relationship flags come from the caller's Human whatever its status (a pending self is still
  -- self); messaging needs an active Human.
  return jsonb_build_object(
    'identity', earth.identity_json(v_target),
    'relationship', earth.relationship_flags_json(v_self, v_target),
    'mutualFriendCount', earth.mutual_friend_count(v_self, v_target),
    'sharedGroupCount', earth.shared_group_count(v_self, v_target),
    'counts', jsonb_build_object(
      'friends', (select count(*) from public.relationships r where r.type = 'friend' and r.source_human_id = v_target),
      'followers', (select count(*) from public.relationships r where r.type = 'follow' and r.target_human_id = v_target),
      'following', (select count(*) from public.relationships r where r.type = 'follow' and r.source_human_id = v_target),
      -- posts land in 04xx; the feed range replaces this count.
      'posts', 0
    ),
    'canMessage', v_viewer is not null and v_viewer <> v_target and not earth.is_blocked_either(v_viewer, v_target)
  );
end
$$;

create or replace function public.identity_update(
  display_name text default null,
  bio text default null,
  avatar_media_id uuid default null,
  profile_visibility public.profile_visibility default null,
  public_city_visibility boolean default null,
  home_city_area_id uuid default null
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

  update public.public_identities p
     set display_name = coalesce(v_name, p.display_name),
         bio = case when v_bio_given then v_bio else p.bio end,
         avatar_media_id = coalesce(v_avatar, p.avatar_media_id),
         profile_visibility = coalesce(v_visibility, p.profile_visibility),
         public_city_visibility = coalesce(v_city_visible, p.public_city_visibility),
         home_city_area_id = coalesce(v_home, p.home_city_area_id)
   where p.human_id = v_human;
  if not found then
    perform earth.raise('claim_identity_missing');
  end if;

  if v_home is not null then
    insert into public.human_context (human_id, home_city_id) values (v_human, v_home)
    on conflict on constraint human_context_pkey do update set home_city_id = excluded.home_city_id;
  end if;

  return earth.identity_json(v_human);
end
$$;

create or replace function public.handle_available(handle text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_handle text := earth.normalize_handle(handle);
begin
  if earth.current_role_kind() = 'visitor' then
    perform earth.raise('not_authenticated');
  end if;
  if not earth.is_valid_handle(v_handle) then
    return false;
  end if;
  return not earth.handle_taken(v_handle, earth.current_human_id());
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Social graph (spec §20–21; mirror: packages/domain/src/social/rules.ts)
-- ---------------------------------------------------------------------------------------------------

-- Writes friendship both ways and drops pending rows; notifies `p_requester` (`friend_accepted`).
create or replace function earth.befriend(p_acceptor uuid, p_requester uuid)
returns void
language plpgsql
volatile
set search_path = public, earth, private, pg_temp
as $$
begin
  delete from public.relationships r
   where r.type = 'friend_pending'
     and ((r.source_human_id = p_acceptor and r.target_human_id = p_requester)
       or (r.source_human_id = p_requester and r.target_human_id = p_acceptor));
  insert into public.relationships (source_human_id, target_human_id, type)
  values (p_acceptor, p_requester, 'friend'), (p_requester, p_acceptor, 'friend')
  on conflict on constraint relationships_source_target_type_key do nothing;
  perform earth.notify(
    p_requester, 'friend_accepted', p_acceptor, 'human', p_acceptor,
    jsonb_build_object('name', coalesce(earth.display_name_of(p_acceptor), 'Someone'))
  );
end
$$;

create or replace function public.friend_request_send(target_human_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_target uuid := target_human_id;
  v_inserted boolean;
begin
  if v_target is null or v_target = v_me then
    perform earth.raise('invalid_input', 'target_human_id must be another Human');
  end if;
  perform earth.assert_active_human(v_target);
  perform earth.rate_limit_for_caller('friend_request', 60, 3600);
  if earth.is_blocked_either(v_me, v_target) then
    perform earth.raise('blocked');
  end if;

  if earth.are_friends(v_me, v_target) then
    return earth.relationship_change_json(v_me, v_target);
  end if;

  if exists (
    select 1 from public.relationships r
     where r.type = 'friend_pending' and r.source_human_id = v_target and r.target_human_id = v_me
  ) then
    perform earth.befriend(v_me, v_target);
    return earth.relationship_change_json(v_me, v_target);
  end if;

  insert into public.relationships (source_human_id, target_human_id, type)
  values (v_me, v_target, 'friend_pending')
  on conflict on constraint relationships_source_target_type_key do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted then
    perform earth.notify(
      v_target, 'friend_request', v_me, 'human', v_me,
      jsonb_build_object('name', coalesce(earth.display_name_of(v_me), 'Someone'))
    );
  end if;

  return earth.relationship_change_json(v_me, v_target);
end
$$;

create or replace function public.friend_request_accept(source_human_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_source uuid := source_human_id;
begin
  if v_source is null or v_source = v_me then
    perform earth.raise('invalid_input', 'source_human_id must be another Human');
  end if;
  perform earth.rate_limit_for_caller('friend_accept', 120, 3600);
  if earth.is_blocked_either(v_me, v_source) then
    perform earth.raise('blocked');
  end if;
  if earth.are_friends(v_me, v_source) then
    return earth.relationship_change_json(v_me, v_source);
  end if;
  if not exists (
    select 1 from public.relationships r
     where r.type = 'friend_pending' and r.source_human_id = v_source and r.target_human_id = v_me
  ) then
    perform earth.raise('invalid_input', 'no pending friend request from source_human_id');
  end if;
  perform earth.befriend(v_me, v_source);
  return earth.relationship_change_json(v_me, v_source);
end
$$;

create or replace function public.friend_request_decline(source_human_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_source uuid := source_human_id;
begin
  if v_source is null or v_source = v_me then
    perform earth.raise('invalid_input', 'source_human_id must be another Human');
  end if;
  perform earth.rate_limit_for_caller('friend_decline', 120, 3600);
  delete from public.relationships r
   where r.type = 'friend_pending' and r.source_human_id = v_source and r.target_human_id = v_me;
  return earth.relationship_change_json(v_me, v_source);
end
$$;

create or replace function public.friend_remove(other_human_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_other uuid := other_human_id;
begin
  if v_other is null or v_other = v_me then
    perform earth.raise('invalid_input', 'other_human_id must be another Human');
  end if;
  perform earth.rate_limit_for_caller('friend_remove', 120, 3600);
  delete from public.relationships r
   where r.type = 'friend'
     and ((r.source_human_id = v_me and r.target_human_id = v_other)
       or (r.source_human_id = v_other and r.target_human_id = v_me));
  return earth.relationship_change_json(v_me, v_other);
end
$$;

create or replace function public.follow_set(target_human_id uuid, following boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_target uuid := target_human_id;
  v_inserted boolean;
begin
  if v_target is null or v_target = v_me then
    perform earth.raise('invalid_input', 'target_human_id must be another Human');
  end if;
  perform earth.rate_limit_for_caller('follow', 60, 3600);
  if coalesce(following, true) then
    perform earth.assert_active_human(v_target);
    if earth.is_blocked_either(v_me, v_target) then
      perform earth.raise('blocked');
    end if;
    insert into public.relationships (source_human_id, target_human_id, type)
    values (v_me, v_target, 'follow')
    on conflict on constraint relationships_source_target_type_key do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted then
      perform earth.notify(
        v_target, 'follow', v_me, 'human', v_me,
        jsonb_build_object('name', coalesce(earth.display_name_of(v_me), 'Someone'))
      );
    end if;
  else
    delete from public.relationships r
     where r.type = 'follow' and r.source_human_id = v_me and r.target_human_id = v_target;
  end if;
  return earth.relationship_change_json(v_me, v_target);
end
$$;

-- Revokes active location shares between two Humans once the 05xx table exists (spec §21 "location").
create or replace function earth.revoke_location_shares_between(p_a uuid, p_b uuid)
returns void
language plpgsql
volatile
set search_path = public, earth, private, pg_temp
as $$
begin
  if to_regclass('public.location_shares') is null then
    return;
  end if;
  if (select count(*) from information_schema.columns c
       where c.table_schema = 'public' and c.table_name = 'location_shares'
         and c.column_name in ('human_id', 'audience_type', 'audience_id', 'revoked_at')) <> 4 then
    return;
  end if;
  execute $q$
    update public.location_shares ls
       set revoked_at = now()
     where ls.revoked_at is null
       and ls.audience_type = 'friend'
       and ((ls.human_id = $1 and ls.audience_id = $2) or (ls.human_id = $2 and ls.audience_id = $1))
  $q$ using p_a, p_b;
end
$$;

create or replace function public.block_set(target_human_id uuid, blocked boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_target uuid := target_human_id;
begin
  if v_target is null or v_target = v_me then
    perform earth.raise('invalid_input', 'target_human_id must be another Human');
  end if;
  if not exists (select 1 from public.humans h where h.id = v_target and h.status <> 'pending') then
    perform earth.raise('not_visible');
  end if;
  perform earth.rate_limit_for_caller('block', 60, 3600);

  if coalesce(blocked, true) then
    insert into public.blocks (blocker_human_id, blocked_human_id)
    values (v_me, v_target)
    on conflict on constraint blocks_pkey do nothing;
    delete from public.relationships r
     where r.type in ('friend', 'friend_pending', 'follow')
       and ((r.source_human_id = v_me and r.target_human_id = v_target)
         or (r.source_human_id = v_target and r.target_human_id = v_me));
    perform earth.revoke_location_shares_between(v_me, v_target);
    perform earth.audit('block_set', 'human', v_target, jsonb_build_object('blocked', true));
  else
    delete from public.blocks b where b.blocker_human_id = v_me and b.blocked_human_id = v_target;
    perform earth.audit('block_set', 'human', v_target, jsonb_build_object('blocked', false));
  end if;

  return earth.relationship_change_json(v_me, v_target)
      || jsonb_build_object('isBlocked', earth.has_blocked(v_me, v_target));
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Presence, context, scopes, push tokens
-- ---------------------------------------------------------------------------------------------------

create or replace function public.presence_ping(
  conversation_id uuid default null,
  room_id uuid default null,
  platform text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_conversation uuid := conversation_id;
  v_room uuid := room_id;
  v_platform text := nullif(btrim(coalesce(platform, '')), '');
  v_row public.human_presence%rowtype;
begin
  perform earth.rate_limit_for_caller('presence_ping', 600, 3600);
  if v_platform is not null and v_platform not in ('ios', 'android', 'web') then
    perform earth.raise('invalid_input', 'platform must be ios, android or web');
  end if;
  if v_conversation is not null and not earth.is_conversation_member(v_conversation, v_me) then
    v_conversation := null;
  end if;

  insert into public.human_presence (human_id, last_active_at, active_conversation_id, active_room_id, platform)
  values (v_me, now(), v_conversation, v_room, v_platform)
  on conflict on constraint human_presence_pkey do update
    set last_active_at = now(),
        active_conversation_id = excluded.active_conversation_id,
        active_room_id = excluded.active_room_id,
        platform = coalesce(excluded.platform, public.human_presence.platform)
  returning * into v_row;

  update public.humans h set last_active_at = now() where h.id = v_me;

  return jsonb_build_object(
    'humanId', v_me,
    'lastActiveAt', to_jsonb(v_row.last_active_at),
    'activeConversationId', v_row.active_conversation_id,
    'activeRoomId', v_row.active_room_id,
    'platform', v_row.platform
  );
end
$$;

create or replace function public.context_set(
  current_area_id uuid default null,
  current_city_id uuid default null,
  home_city_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_area uuid := current_area_id;
  v_city uuid := current_city_id;
  v_home uuid := home_city_id;
  v_id uuid;
begin
  perform earth.rate_limit_for_caller('context_set', 120, 3600);

  foreach v_id in array array_remove(array[v_area, v_city, v_home], null) loop
    if not exists (select 1 from public.areas a where a.id = v_id) then
      perform earth.raise('area_not_found');
    end if;
  end loop;
  if v_city is not null and not exists (select 1 from public.areas a where a.id = v_city and a.type = 'city') then
    perform earth.raise('invalid_input', 'current_city_id must be a city');
  end if;
  if v_home is not null and not exists (select 1 from public.areas a where a.id = v_home and a.type = 'city') then
    perform earth.raise('invalid_input', 'home_city_id must be a city');
  end if;
  if v_area is not null and v_city is null then
    v_city := earth.area_ancestor_of_type(v_area, 'city');
  end if;

  insert into public.human_context (human_id, current_area_id, current_city_id, home_city_id)
  values (v_me, v_area, v_city, v_home)
  on conflict on constraint human_context_pkey do update
    set current_area_id = coalesce(excluded.current_area_id, public.human_context.current_area_id),
        current_city_id = coalesce(excluded.current_city_id, public.human_context.current_city_id),
        home_city_id = coalesce(excluded.home_city_id, public.human_context.home_city_id);

  -- A neighborhood outside the (new) current city is stale.
  update public.human_context hc
     set current_area_id = null
   where hc.human_id = v_me
     and hc.current_area_id is not null
     and hc.current_city_id is not null
     and not earth.area_contains(hc.current_city_id, hc.current_area_id);

  if v_home is not null then
    update public.public_identities p set home_city_area_id = v_home where p.human_id = v_me;
  end if;

  return earth.human_context_json(v_me);
end
$$;

create or replace function public.scope_set(surface text, scope public.audience)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_surface text := lower(btrim(coalesce(surface, '')));
  v_scope public.audience := scope;
begin
  perform earth.rate_limit_for_caller('scope_set', 300, 3600);
  if v_surface not in ('home', 'live', 'earth') then
    perform earth.raise('invalid_input', 'surface must be home, live or earth');
  end if;
  if v_scope is null then
    perform earth.raise('invalid_input', 'scope is required');
  end if;

  insert into public.human_context (human_id, last_scope_home, last_scope_live, last_scope_earth)
  values (
    v_me,
    case when v_surface = 'home' then v_scope else 'friends' end,
    case when v_surface = 'live' then v_scope else 'friends' end,
    case when v_surface = 'earth' then v_scope else 'friends' end
  )
  on conflict on constraint human_context_pkey do update
    set last_scope_home = case when v_surface = 'home' then excluded.last_scope_home else public.human_context.last_scope_home end,
        last_scope_live = case when v_surface = 'live' then excluded.last_scope_live else public.human_context.last_scope_live end,
        last_scope_earth = case when v_surface = 'earth' then excluded.last_scope_earth else public.human_context.last_scope_earth end;

  return jsonb_build_object('surface', v_surface, 'scope', v_scope);
end
$$;

create or replace function public.push_token_register(token text, platform text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_token text := nullif(btrim(coalesce(token, '')), '');
  v_platform text := nullif(btrim(coalesce(platform, '')), '');
  v_row public.push_tokens%rowtype;
begin
  perform earth.rate_limit_for_caller('push_token', 60, 3600);
  if v_token is null or length(v_token) > 4096 then
    perform earth.raise('invalid_input', 'token is required');
  end if;
  if v_platform is null or v_platform not in ('ios', 'android', 'web') then
    perform earth.raise('invalid_input', 'platform must be ios, android or web');
  end if;

  -- A device token belongs to whoever signed in last on that device.
  delete from public.push_tokens pt where pt.token = v_token and pt.human_id <> v_me;

  insert into public.push_tokens (human_id, token, platform)
  values (v_me, v_token, v_platform)
  on conflict on constraint push_tokens_pkey do update
    set platform = excluded.platform, updated_at = now()
  returning * into v_row;

  return jsonb_build_object('token', v_row.token, 'platform', v_row.platform, 'updatedAt', to_jsonb(v_row.updated_at));
end
$$;

create or replace function public.push_token_remove(token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_token text := nullif(btrim(coalesce(token, '')), '');
  v_removed integer;
begin
  perform earth.rate_limit_for_caller('push_token', 60, 3600);
  delete from public.push_tokens pt where pt.human_id = v_me and pt.token = v_token;
  get diagnostics v_removed = row_count;
  return jsonb_build_object('removed', v_removed > 0);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- me_get: who the caller is (MeDto), for every caller kind including visitors.
-- ---------------------------------------------------------------------------------------------------

create or replace function public.me_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_human public.humans%rowtype;
begin
  if v_kind in ('claiming', 'human') then
    select * into v_human from public.humans h where h.auth_user_id = auth.uid() limit 1;
  end if;
  return jsonb_build_object(
    'roleKind', v_kind,
    'humanId', v_human.id,
    'identity', case when v_human.id is null then null else earth.identity_json(v_human.id) end,
    'humanStatus', v_human.status,
    'humanPassStatus', v_human.human_pass_status,
    'context', case when v_human.status = 'active' then earth.human_context_json(v_human.id) else null end,
    'flags', earth.flags_json()
  );
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------

revoke execute on function public.claim_start(text, text, text) from public;
revoke execute on function public.claim_get() from public;
revoke execute on function public.claim_set_identity(text, text, uuid) from public;
revoke execute on function public.claim_verification_begin(text) from public;
revoke execute on function public.human_pass_record_result(uuid, public.human_pass_status, text, text, text, jsonb, uuid) from public;
revoke execute on function public.identity_review_create(text, jsonb) from public;
revoke execute on function public.claim_complete() from public;
revoke execute on function public.profile_get(text) from public;
revoke execute on function public.identity_update(text, text, uuid, public.profile_visibility, boolean, uuid) from public;
revoke execute on function public.handle_available(text) from public;
revoke execute on function public.friend_request_send(uuid) from public;
revoke execute on function public.friend_request_accept(uuid) from public;
revoke execute on function public.friend_request_decline(uuid) from public;
revoke execute on function public.friend_remove(uuid) from public;
revoke execute on function public.follow_set(uuid, boolean) from public;
revoke execute on function public.block_set(uuid, boolean) from public;
revoke execute on function public.presence_ping(uuid, uuid, text) from public;
revoke execute on function public.context_set(uuid, uuid, uuid) from public;
revoke execute on function public.scope_set(text, public.audience) from public;
revoke execute on function public.push_token_register(text, text) from public;
revoke execute on function public.push_token_remove(text) from public;
revoke execute on function public.me_get() from public;

grant execute on function public.claim_start(text, text, text) to anon, authenticated, service_role;
grant execute on function public.claim_get() to anon, authenticated, service_role;
grant execute on function public.claim_set_identity(text, text, uuid) to anon, authenticated, service_role;
grant execute on function public.claim_verification_begin(text) to anon, authenticated, service_role;
grant execute on function public.human_pass_record_result(uuid, public.human_pass_status, text, text, text, jsonb, uuid) to anon, authenticated, service_role;
grant execute on function public.identity_review_create(text, jsonb) to anon, authenticated, service_role;
grant execute on function public.claim_complete() to anon, authenticated, service_role;
grant execute on function public.profile_get(text) to anon, authenticated, service_role;
grant execute on function public.identity_update(text, text, uuid, public.profile_visibility, boolean, uuid) to anon, authenticated, service_role;
grant execute on function public.handle_available(text) to anon, authenticated, service_role;
grant execute on function public.friend_request_send(uuid) to anon, authenticated, service_role;
grant execute on function public.friend_request_accept(uuid) to anon, authenticated, service_role;
grant execute on function public.friend_request_decline(uuid) to anon, authenticated, service_role;
grant execute on function public.friend_remove(uuid) to anon, authenticated, service_role;
grant execute on function public.follow_set(uuid, boolean) to anon, authenticated, service_role;
grant execute on function public.block_set(uuid, boolean) to anon, authenticated, service_role;
grant execute on function public.presence_ping(uuid, uuid, text) to anon, authenticated, service_role;
grant execute on function public.context_set(uuid, uuid, uuid) to anon, authenticated, service_role;
grant execute on function public.scope_set(text, public.audience) to anon, authenticated, service_role;
grant execute on function public.push_token_register(text, text) to anon, authenticated, service_role;
grant execute on function public.push_token_remove(text) to anon, authenticated, service_role;
grant execute on function public.me_get() to anon, authenticated, service_role;

-- Internal helpers that mutate or reveal state stay owner/service only.
revoke execute on function earth.befriend(uuid, uuid) from public, anon, authenticated;
revoke execute on function earth.revoke_location_shares_between(uuid, uuid) from public, anon, authenticated;
