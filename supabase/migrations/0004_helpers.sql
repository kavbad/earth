-- 0004 — earth.* helper functions (ARCHITECTURE §5, DB_API conventions).
--
-- Every RPC uses these: earth.raise(code) for machine-readable errors, earth.sha256_hex /
-- earth.random_token for invite and session tokens, earth.jwt_claims / earth.is_anonymous_jwt /
-- earth.is_service_role to classify the caller, earth.utc_now as the single clock.
-- Helpers live in `earth` (no USAGE for anon/authenticated) and are reached from security definer
-- RPCs or from RLS policies.

-- sha256 of a text value as lowercase hex. Used for token hashes (tokens are never stored in clear).
create or replace function earth.sha256_hex(input text)
returns text
language sql
immutable
strict
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select encode(sha256(convert_to(input, 'UTF8')), 'hex')
$$;

-- 32 random bytes as unpadded base64url (43 chars). The plaintext is returned to the creator exactly
-- once; only earth.sha256_hex(token) is stored. `extensions` is on the search_path for pgcrypto.
create or replace function earth.random_token()
returns text
language sql
volatile
set search_path = public, earth, private, extensions, pg_temp
as $$
  select rtrim(
    translate(replace(encode(gen_random_bytes(32), 'base64'), E'\n', ''), '+/', '-_'),
    '='
  )
$$;

-- Raises the machine error code as the exception message with errcode P0001 (ARCHITECTURE §5).
-- `code` must be a code from packages/domain/src/errors.ts; `detail` is optional operator context.
create or replace function earth.raise(code text, detail text default null)
returns void
language plpgsql
volatile
set search_path = public, earth, private, pg_temp
as $$
begin
  if code is null or code = '' then
    raise exception using errcode = 'P0001', message = 'internal', detail = 'earth.raise called without a code';
  end if;
  if detail is null then
    raise exception using errcode = 'P0001', message = code;
  end if;
  raise exception using errcode = 'P0001', message = code, detail = detail;
end
$$;

-- The single clock. Tests may freeze or advance time with `set local earth.now = '<timestamptz>'`.
create or replace function earth.utc_now()
returns timestamptz
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select coalesce(nullif(current_setting('earth.now', true), '')::timestamptz, now())
$$;

-- request.jwt.claims parsed defensively: '{}' when absent, empty, malformed or not an object.
create or replace function earth.jwt_claims()
returns jsonb
language plpgsql
stable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_raw text;
  v_claims jsonb;
begin
  v_raw := nullif(current_setting('request.jwt.claims', true), '');
  if v_raw is null then
    return '{}'::jsonb;
  end if;
  begin
    v_claims := v_raw::jsonb;
  exception
    when invalid_text_representation then
      return '{}'::jsonb;
  end;
  if jsonb_typeof(v_claims) <> 'object' then
    return '{}'::jsonb;
  end if;
  return v_claims;
end
$$;

-- True for a Supabase anonymous sign-in (Guest credential, ARCHITECTURE §4).
create or replace function earth.is_anonymous_jwt()
returns boolean
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select coalesce(earth.jwt_claims() ->> 'is_anonymous', 'false') = 'true'
$$;

-- True when the caller is the server tier (service_role JWT) or a trusted database session with no JWT
-- at all (migrations, seeds, psql as postgres). With a JWT present, only its role claim decides:
-- current_user is the function owner inside security definer RPCs and session_user never changes
-- under `set role`, so neither can tell an impersonated visitor from the service.
create or replace function earth.is_service_role()
returns boolean
language plpgsql
stable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_claims jsonb := earth.jwt_claims();
begin
  if v_claims <> '{}'::jsonb then
    return coalesce(v_claims ->> 'role', '') = 'service_role';
  end if;
  return session_user in ('postgres', 'supabase_admin', 'service_role')
      or current_user = 'service_role';
end
$$;

-- request.headers parsed defensively. PostgREST sets it to a JSON object of the request headers
-- (names lower-cased); '{}' when absent, empty, malformed or not an object.
create or replace function earth.request_headers()
returns jsonb
language plpgsql
stable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_raw text;
  v_headers jsonb;
begin
  v_raw := nullif(current_setting('request.headers', true), '');
  if v_raw is null then
    return '{}'::jsonb;
  end if;
  begin
    v_headers := v_raw::jsonb;
  exception
    when invalid_text_representation then
      return '{}'::jsonb;
  end;
  if jsonb_typeof(v_headers) <> 'object' then
    return '{}'::jsonb;
  end if;
  return v_headers;
end
$$;

-- Best-effort network address of the end client, as text; keys Visitor rate limits (0005).
-- Sources in order of trust: `cf-connecting-ip` and `x-real-ip` (set and overwritten by the edge in
-- front of the API, so not client-controlled), the LAST hop of `x-forwarded-for` (the peer of the
-- proxy that appended it; the first hop is whatever the client sent), then the socket peer (which is
-- PostgREST itself for API traffic, so it is only ever a last resort). Values that do not parse as an
-- address are skipped; null when nothing is usable.
create or replace function earth.client_address()
returns text
language plpgsql
stable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_headers jsonb := earth.request_headers();
  v_candidate text;
begin
  foreach v_candidate in array array[
    v_headers ->> 'cf-connecting-ip',
    v_headers ->> 'x-real-ip',
    split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', -1),
    host(inet_client_addr())
  ]
  loop
    v_candidate := nullif(btrim(v_candidate), '');
    if v_candidate is null then
      continue;
    end if;
    begin
      return host(v_candidate::inet);
    exception
      when invalid_text_representation then
        null; -- not an address: try the next source
    end;
  end loop;
  return null;
end
$$;
