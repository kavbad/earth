-- 0001 — extensions (ARCHITECTURE §3, §5).
--
-- Extensions live in the `extensions` schema, where hosted Supabase installs them. Column types
-- (`extensions.geometry(...)`) resolve at DDL time; the migration runner and the local database set
-- `search_path = public, extensions` (scripts/db/migrate-lib.ts) so unqualified names work in
-- migrations exactly as they do for the hosted `postgres` role. Functions that call extension
-- functions at runtime must either schema-qualify them or include `extensions` in their own
-- `set search_path` (see earth.random_token() in 0004).

create schema if not exists extensions;
grant usage on schema extensions to anon, authenticated, service_role;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists postgis with schema extensions;

-- uuid-ossp is optional: gen_random_uuid() is built in, but some tooling still expects uuid_generate_v4().
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'uuid-ossp') then
    create extension if not exists "uuid-ossp" with schema extensions;
  else
    raise notice '0001_extensions: uuid-ossp not available, skipping';
  end if;
end
$$;
