-- 1020 — age gating (spec §84 "Minor handling"): Earth launches 18+, so the architecture for a
-- minimum-age policy exists in the database from day one while the product scope stays exactly
-- what it is today. Nothing here changes what any Human can do: the column ships as `unknown` for
-- everyone, and `unknown` claims exactly as it did before this migration.
--
-- Three pieces, in the order they are used:
--
--   1. `public.humans.age_bracket` — `unknown` | `adult` | `minor`, default `unknown`. This is a
--      *result of identity verification*, never a self-declaration: the verification provider
--      integration (the service role, through `human_pass_record_result` and the provider webhook
--      that calls it) is the only writer. No client role holds INSERT or UPDATE on
--      `public.humans` at all (0170 grants SELECT only, behind `humans_select_own`), and the
--      column privilege is revoked explicitly below so a later grant cannot open it by accident.
--      Age is not a public identity attribute: it is not in any DTO and no RPC returns it.
--
--   2. `app_settings.minimum_age_policy` — the launch policy, `18_plus`. The one other value the
--      gate recognises is `all_ages`, which V1 never sets; if minors are ever permitted, spec §84
--      makes the stricter minor requirements launch blockers, and flipping this key is the switch
--      that turns them on. Anything unrecognised (a typo, a missing row) is read as `18_plus`:
--      the gate fails closed, because "do not accidentally admit minors into adult defaults" is
--      the whole point of §84.
--
--   3. `earth.age_policy_allows(human_id)` — the single place that answers "may this Human hold a
--      place on Earth under the current policy?". `claim_complete` consults it as the last gate
--      before activation and refuses a marked minor with `age_not_allowed`
--      (`packages/domain/src/errors.ts`). Every other surface stays untouched: an already-active
--      Human is not retro-deactivated here, because deactivating existing Humans is a policy
--      operation with its own review path, not a schema migration.

-- ---------------------------------------------------------------------------------------------------
-- 1. humans.age_bracket (service-only)
-- ---------------------------------------------------------------------------------------------------

create type public.age_bracket as enum ('unknown', 'adult', 'minor');

alter table public.humans
  add column age_bracket public.age_bracket not null default 'unknown';

comment on column public.humans.age_bracket is
  'Spec §84 age bracket, written only by the verification provider integration (service role). '
  'Clients hold no write privilege on public.humans; earth.age_policy_allows reads it at claim time.';

-- 0002 revoked every client write on public.humans and 0170 granted SELECT only; the column-level
-- revoke restates that intent so the writer set cannot widen silently.
revoke insert, update on table public.humans from anon, authenticated;
revoke update (age_bracket) on table public.humans from anon, authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 2. minimum_age_policy
-- ---------------------------------------------------------------------------------------------------

insert into public.app_settings (key, value) values ('minimum_age_policy', '18_plus')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------------------------------
-- 3. earth.age_policy_allows
-- ---------------------------------------------------------------------------------------------------

-- Whether the current minimum-age policy admits `p_human_id`. True for every Human whose bracket is
-- `unknown` or `adult` (today: everyone), and for a minor only while the policy is `all_ages`.
-- Unknown Humans and unrecognised policy values fall back to the strict answer.
create or replace function earth.age_policy_allows(p_human_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_policy text := coalesce(nullif(btrim(earth.setting('minimum_age_policy')), ''), '18_plus');
  v_bracket public.age_bracket;
begin
  if p_human_id is null then
    return false;
  end if;
  select h.age_bracket into v_bracket from public.humans h where h.id = p_human_id;
  if not found then
    return false;
  end if;
  if v_bracket <> 'minor' then
    return true;
  end if;
  return v_policy = 'all_ages';
end
$$;

-- Only `claim_complete` consults it, and that is `security definer`, so no client grant is needed.
-- Schema `earth` grants EXECUTE on new functions to `anon`/`authenticated` by default (0002) for the
-- helpers RLS policies call as the caller; this one is revoked, because a client that could call it
-- could probe whether any Human is a minor, and verification details are private (spec §78).
revoke execute on function earth.age_policy_allows(uuid) from anon, authenticated;

-- ---------------------------------------------------------------------------------------------------
-- 4. claim_complete consults the gate (0952 verbatim, with the one added gate marked below)
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

  -- 1020: age gate (spec §84). Verification is what establishes the bracket, so the policy is read
  -- after it and immediately before activation. `unknown` and `adult` pass, as they always did.
  if not earth.age_policy_allows(v_human_id) then
    perform earth.raise('age_not_allowed');
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

-- Grants (unchanged profile, restated: create or replace keeps ACLs, the convention is explicit).
revoke execute on function public.claim_complete() from public;
grant execute on function public.claim_complete() to anon, authenticated, service_role;
