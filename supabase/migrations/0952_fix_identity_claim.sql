-- 0952 — identity invariant fixes from adversarial verification (ARCHITECTURE §4; spec §42, §48,
-- §77–80; DB_API §1). Each finding is reproduced by supabase/tests/src/verify/identity.test.ts.
--
--   1. Guest is not Human. earth.current_human_id() / earth.current_human() resolved a Human for an
--      anonymous JWT whenever a Human row was linked to that auth user, so every RLS surface keyed
--      on them (own-row reads and edits, human_context, media_objects) opened for a Guest even
--      though earth.current_role_kind() said `guest`. They now return null for anonymous
--      credentials, exactly as the state table in ARCHITECTURE §4 promises.
--   2. A credential is never a Human. claim_start left the `supabase` auth_identities row (and the
--      email/phone method rows) pointing at a previous, deleted Human of the same credential, so
--      the new pending Human had no credential row at all. The rows now follow the credential.
--   3. A Human cannot silently create a second Human. A new credential whose verified email or
--      phone is already the method row of a living Human went through claim_start unnoticed and
--      could complete with any passing verification. The system now opens a `duplicate` identity
--      review (spec §48 "provider or system determines likely existing Human"), which
--      claim_complete refuses with `duplicate_human` until a person resolves it.
--   4. human_pass_record_result recorded a `verified` pass even when the provider named a
--      duplicate_of_human_id, and only opened a review for `review_required`, so the claim could
--      complete. Any duplicate hint now opens the review, and a "verified" result carrying a hint
--      is recorded as `review_required` (a verified pass and a duplicate finding contradict).
--   5. claim_complete let a confirmed duplicate (duplicate review rejected by a person) activate by
--      simply re-running verification until a clean `verified` pass came back. A confirmed
--      duplicate now needs an explicit approved review (spec §79) — never the automatic path.
--   6. An approved `recovery` or `safety` review counted as Human verification, so the recovery
--      path could activate the pending (replacement) Human — spec §80 "Recovery does not create a
--      replacement Human by default". Only `help`, `inconclusive` and `duplicate` approvals verify.
--   7. Concurrent claim_start calls for one credential could surface a raw unique_violation; the
--      insert is race-safe now (one Human; the loser continues on the winner's row).
--
-- Rate-limit literals are unchanged (0730 inventory). No table or grant changes; one policy
-- predicate is tightened (humans_select_own) for finding 1.

-- ---------------------------------------------------------------------------------------------------
-- 1. Guest is not Human: anonymous credentials never resolve to a Human.
-- ---------------------------------------------------------------------------------------------------

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
     and not earth.is_anonymous_jwt()
   limit 1
$$;

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
     and not earth.is_anonymous_jwt()
     and h.status = 'active'
   limit 1
$$;

-- The own-row policy on humans (0170) keyed on auth.uid() directly; a Guest JWT must not read a
-- Human row either, even one linked to its anonymous auth user. The security definer helper is the
-- single source (a plain sql helper cannot be named from a policy: no USAGE on schema earth).
alter policy humans_select_own on public.humans
  using (id = earth.current_human_id());

-- ---------------------------------------------------------------------------------------------------
-- 5 + 6. What counts as an approved manual review, and whether a duplicate conflict is unresolved.
-- ---------------------------------------------------------------------------------------------------

-- An approved review of a kind that stands in for Human verification (spec §77 "approved manual
-- review", §79 "Get help verifying"): `help`, `inconclusive`, or `duplicate` ("This isn't me"
-- upheld). `recovery` and `safety` act on the *existing* Human (spec §80) and never verify a new one.
create or replace function earth.claim_review_approved(p_human_id uuid)
returns boolean
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select exists (
    select 1
      from public.identity_reviews r
     where r.human_id = p_human_id
       and r.status = 'approved'
       and r.kind in ('help', 'inconclusive', 'duplicate')
  )
$$;

-- 'open' while a duplicate review is unresolved; 'confirmed' once a person rejected the claimant's
-- position (it really is an existing Human) and no duplicate review was ever approved; null when
-- there is no duplicate conflict.
create or replace function earth.claim_duplicate_conflict(p_human_id uuid)
returns text
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select case
           when exists (
             select 1 from public.identity_reviews r
              where r.human_id = p_human_id and r.kind = 'duplicate' and r.status = 'open'
           ) then 'open'
           when exists (
             select 1 from public.identity_reviews r
              where r.human_id = p_human_id and r.kind = 'duplicate' and r.status = 'rejected'
           ) and not exists (
             select 1 from public.identity_reviews r
              where r.human_id = p_human_id and r.kind = 'duplicate' and r.status = 'approved'
           ) then 'confirmed'
           else null
         end
$$;

-- `ClaimStateDto` (0180), with the approved-review rule above.
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
  v_approved := earth.claim_review_approved(v_human.id);
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

-- ---------------------------------------------------------------------------------------------------
-- 2 + 3. Credential rows follow the credential; a method already verified by a living Human is a
--        likely existing Human.
-- ---------------------------------------------------------------------------------------------------

-- Records the caller's credential on a freshly created pending Human (ARCHITECTURE §4 method rows).
-- The `supabase` row always follows the credential: humans.auth_user_id is unique and the caller
-- just took it, so any previous holder (a deleted or unlinked Human) no longer owns that subject.
-- An email/phone row already held by a *living* Human is not taken over: it is the system's own
-- duplicate signal (spec §48), so a `duplicate` review is opened on the new pending Human and
-- claim_complete refuses with `duplicate_human` until a person resolves it. Rows of deleted or
-- pending Humans, or revoked methods, follow the credential.
create or replace function earth.claim_link_credential(p_human_id uuid, p_uid uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_claims jsonb := earth.jwt_claims();
  v_method record;
  v_existing record;
begin
  if p_human_id is null or p_uid is null then
    perform earth.raise('internal', 'claim_link_credential: human id and auth user id required');
  end if;

  insert into public.auth_identities (human_id, provider, provider_subject, verified_at)
  values (p_human_id, 'supabase', p_uid::text, now())
  on conflict on constraint auth_identities_provider_subject_key do update
    set human_id = excluded.human_id,
        verified_at = now(),
        revoked_at = null;

  for v_method in
    select 'email'::text as provider,
           nullif(lower(btrim(coalesce(v_claims ->> 'email', ''))), '') as subject
    union all
    select 'phone'::text,
           nullif(btrim(coalesce(v_claims ->> 'phone', '')), '')
  loop
    if v_method.subject is null then
      continue;
    end if;

    select ai.human_id, ai.revoked_at, h.status
      into v_existing
      from public.auth_identities ai
      join public.humans h on h.id = ai.human_id
     where ai.provider = v_method.provider
       and ai.provider_subject = v_method.subject;

    if not found then
      insert into public.auth_identities (human_id, provider, provider_subject, verified_at)
      values (p_human_id, v_method.provider, v_method.subject, now())
      on conflict on constraint auth_identities_provider_subject_key do nothing;
    elsif v_existing.human_id = p_human_id then
      null;
    elsif v_existing.status in ('active', 'restricted', 'suspended') and v_existing.revoked_at is null then
      if not exists (
        select 1 from public.identity_reviews r
         where r.human_id = p_human_id and r.kind = 'duplicate' and r.status = 'open'
      ) then
        insert into public.identity_reviews (human_id, kind, status, details, duplicate_of_human_id)
        values (
          p_human_id, 'duplicate', 'open',
          jsonb_build_object(
            'duplicateOfHumanId', v_existing.human_id,
            'source', 'auth_identity',
            'provider', v_method.provider
          ),
          v_existing.human_id
        );
        perform earth.audit(
          'identity_duplicate_detected', 'human', p_human_id,
          jsonb_build_object('duplicateOfHumanId', v_existing.human_id, 'provider', v_method.provider)
        );
      end if;
    else
      update public.auth_identities ai
         set human_id = p_human_id,
             verified_at = now(),
             revoked_at = null
       where ai.provider = v_method.provider
         and ai.provider_subject = v_method.subject;
    end if;
  end loop;
end
$$;

revoke execute on function earth.claim_link_credential(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 2 + 3 + 7. claim_start (0180), race-safe and linking the credential through the helper above.
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
    on conflict on constraint humans_auth_user_id_key do nothing
    returning * into v_human;

    if v_human.id is not null then
      perform earth.claim_link_credential(v_human.id, v_uid);
      return earth.claim_state_json(v_human.id);
    end if;

    -- A concurrent claim_start for this credential won the race: continue on its row.
    select * into v_human from public.humans h where h.auth_user_id = v_uid limit 1;
    if v_human.id is null or v_human.status <> 'pending' then
      perform earth.raise('duplicate_human');
    end if;
  end if;

  update public.humans h
     set claim_intent = v_intent,
         claim_group_label = v_label,
         claim_invite_token_hash = v_hash
   where h.id = v_human.id;

  return earth.claim_state_json(v_human.id);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- 4. human_pass_record_result (0180): a duplicate hint always opens the review and never leaves a
--    verified pass behind. Still never activates the Human.
-- ---------------------------------------------------------------------------------------------------

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

  -- A result that names an existing Human is a duplicate finding, whatever the provider called it:
  -- it needs a person (spec §48), so it is never stored as a verified pass.
  if v_duplicate is not null and v_status = 'verified' then
    v_status := 'review_required';
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

  if v_duplicate is not null
     and not exists (
       select 1 from public.identity_reviews r
        where r.human_id = v_human and r.kind = 'duplicate' and r.status = 'open'
     ) then
    insert into public.identity_reviews (human_id, kind, status, details, duplicate_of_human_id)
    values (
      v_human, 'duplicate', 'open',
      jsonb_build_object('duplicateOfHumanId', v_duplicate, 'source', 'human_pass', 'resultStatus', status),
      v_duplicate
    );
  end if;

  perform earth.audit(
    'human_pass_record_result', 'human', v_human,
    jsonb_build_object('status', v_status, 'riskLevel', v_risk, 'duplicateOfHumanId', v_duplicate)
  );

  return earth.claim_state_json(v_human);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- 5 + 6. claim_complete (0180): a confirmed duplicate never activates through the automatic path;
--        recovery/safety approvals are not verification.
-- ---------------------------------------------------------------------------------------------------

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
  v_conflict text;
  v_approved boolean;
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

  v_conflict := earth.claim_duplicate_conflict(v_human_id);
  if v_conflict = 'open' then
    perform earth.raise('duplicate_human');
  end if;

  v_approved := earth.claim_review_approved(v_human_id);
  v_verified := v_human.human_pass_status = 'verified' or v_approved;
  if not v_verified then
    v_open_review := exists (
      select 1 from public.identity_reviews r where r.human_id = v_human_id and r.status = 'open'
    );
    if v_human.human_pass_status in ('verifying', 'review_required') or v_open_review then
      perform earth.raise('verification_pending');
    end if;
    perform earth.raise('verification_required');
  end if;

  -- A person confirmed this claimant is an existing Human: only an explicit approved review may
  -- override that, never another automatic pass (spec §48 "never create a second active Human
  -- automatically").
  if v_conflict = 'confirmed' and not v_approved then
    perform earth.raise('duplicate_human');
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
-- Grants (unchanged profiles, restated: create or replace keeps ACLs, the convention is explicit).
-- ---------------------------------------------------------------------------------------------------

revoke execute on function public.claim_start(text, text, text) from public;
revoke execute on function public.human_pass_record_result(uuid, public.human_pass_status, text, text, text, jsonb, uuid) from public;
revoke execute on function public.claim_complete() from public;

grant execute on function public.claim_start(text, text, text) to anon, authenticated, service_role;
grant execute on function public.human_pass_record_result(uuid, public.human_pass_status, text, text, text, jsonb, uuid) to anon, authenticated, service_role;
grant execute on function public.claim_complete() to anon, authenticated, service_role;
