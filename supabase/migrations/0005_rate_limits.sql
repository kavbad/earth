-- 0005 — rate limits (spec §83, ARCHITECTURE §1 rule-home table).
--
-- Fixed windows keyed by `<action>:<subject>`. earth.rate_limit is called from security definer RPCs;
-- a rejected call raises `rate_limited` and its own increment rolls back with the transaction, so
-- refused attempts never extend the window. Every row carries its own expiry, so windows of any
-- length survive pruning; rooms_sweep() prunes expired rows through earth.rate_limit_prune().
--
-- private.rate_limits is owner-only. The rate-limit functions are executable by their owner and the
-- service role only: RLS policies never rate-limit, so anon/authenticated get no EXECUTE on them even
-- though schema `earth` grants EXECUTE on new functions by default (0002).

create table private.rate_limits (
  key text primary key,
  window_start timestamptz not null,
  expires_at timestamptz not null,
  count integer not null default 0,
  constraint rate_limits_window_check check (expires_at > window_start),
  constraint rate_limits_count_check check (count >= 0)
);

create index rate_limits_expires_at_idx on private.rate_limits (expires_at);

alter table private.rate_limits enable row level security;
revoke all on table private.rate_limits from public, anon, authenticated, service_role;

-- Counts one attempt for `subject` on `action`; raises `rate_limited` when the attempt exceeds
-- `max_count` within `window_seconds`. Returns the remaining budget in the current window.
-- `action` must not contain ':' so `<action>:<subject>` keys cannot collide.
create or replace function earth.rate_limit(
  action text,
  subject text,
  max_count integer,
  window_seconds integer
)
returns integer
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_key text;
  v_now timestamptz;
  v_window interval;
  v_count integer;
begin
  if action is null or action = '' or position(':' in action) > 0
     or subject is null or subject = ''
     or max_count is null or max_count < 0
     or window_seconds is null or window_seconds <= 0 then
    perform earth.raise(
      'invalid_input',
      'earth.rate_limit: action (without ":"), subject, max_count >= 0 and window_seconds > 0 are required'
    );
  end if;

  v_key := action || ':' || subject;
  v_now := earth.utc_now();
  v_window := make_interval(secs => window_seconds);

  insert into private.rate_limits as rl (key, window_start, expires_at, count)
  values (v_key, v_now, v_now + v_window, 1)
  on conflict (key) do update
    set window_start = case when rl.expires_at <= v_now then v_now else rl.window_start end,
        expires_at   = case when rl.expires_at <= v_now then v_now + v_window else rl.expires_at end,
        count        = case when rl.expires_at <= v_now then 1 else rl.count + 1 end
  returning rl.count into v_count;

  if v_count > max_count then
    perform earth.raise(
      'rate_limited',
      format('%s: attempt %s of %s within %ss', action, v_count, max_count, window_seconds)
    );
  end if;

  return max_count - v_count;
end
$$;

-- The budget of a caller without a Human credential: half of `max_count`, rounded up so a positive
-- limit never becomes zero (spec §83 "Guests receive stricter limits").
create or replace function earth.rate_limit_reduced_budget(max_count integer)
returns integer
language sql
immutable
strict
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select ceil(max_count * 0.5)::integer
$$;

-- Rate limit for the current caller, by state (ARCHITECTURE §4):
--   service            never limited;
--   Human / claiming   keyed by the auth user id, full budget;
--   Guest              keyed by the anonymous auth user id, reduced budget;
--   Visitor            keyed by earth.client_address() (else the shared key 'anon'), reduced budget —
--                      a caller with no credential at all is never trusted more than a Guest.
create or replace function earth.rate_limit_for_caller(
  action text,
  max_count integer,
  window_seconds integer
)
returns integer
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_subject text;
  v_max integer := max_count;
begin
  if earth.is_service_role() then
    return max_count;
  end if;

  if v_uid is not null then
    v_subject := v_uid::text;
    if earth.is_anonymous_jwt() then
      v_max := earth.rate_limit_reduced_budget(max_count);
    end if;
  else
    v_subject := coalesce(earth.client_address(), 'anon');
    v_max := earth.rate_limit_reduced_budget(max_count);
  end if;

  return earth.rate_limit(action, v_subject, v_max, window_seconds);
end
$$;

-- Deletes windows that expired at least `max_age_seconds` ago (default: every expired window). A live
-- window is never removed, whatever its length. Returns the number of rows removed.
create or replace function earth.rate_limit_prune(max_age_seconds integer default 0)
returns integer
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_deleted integer;
begin
  if max_age_seconds is null or max_age_seconds < 0 then
    perform earth.raise('invalid_input', 'earth.rate_limit_prune: max_age_seconds must be >= 0');
  end if;
  delete from private.rate_limits
  where expires_at <= earth.utc_now() - make_interval(secs => max_age_seconds);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$$;

-- Only security definer RPCs (owner) and the service role may rate-limit; never a policy.
revoke execute on function earth.rate_limit(text, text, integer, integer) from public, anon, authenticated;
revoke execute on function earth.rate_limit_for_caller(text, integer, integer) from public, anon, authenticated;
revoke execute on function earth.rate_limit_prune(integer) from public, anon, authenticated;
