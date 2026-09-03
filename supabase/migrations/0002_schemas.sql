-- 0002 — schemas and the privilege baseline (ARCHITECTURE §5).
--
--   public   exposed tables + RPC. API roles get USAGE only; every table/function/sequence must be
--            granted explicitly by the migration that creates it. Nothing is granted by default to
--            anon/authenticated, and new functions are not executable by PUBLIC either.
--   earth    internal helpers. No USAGE for anon/authenticated (they cannot name earth.* directly).
--            New functions are granted to the API roles by default so RLS policies evaluated as
--            anon/authenticated may call earth.* helpers (execution checks EXECUTE, not schema USAGE).
--   private  Human Pass metadata, rate limits, audit. Owner only; reached through security definer
--            functions.
--
-- Default privileges bind to the role running migrations (`postgres` locally and on hosted Supabase).
-- Postgres grants EXECUTE on new functions to PUBLIC, and schema-scoped default privileges can only
-- add to the global defaults, so that built-in grant is removed with the global form below and
-- re-added explicitly per schema where wanted.

create schema if not exists earth;
create schema if not exists private;

-- public ---------------------------------------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated, public;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges revoke execute on functions from public;

alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;

-- The migration ledger is created by the runner before any migration (local stack and tests only).
alter table if exists public.earth_migrations enable row level security;
revoke all on table public.earth_migrations from anon, authenticated;

-- earth ----------------------------------------------------------------------------------------------
revoke all on schema earth from public, anon, authenticated;
grant usage on schema earth to service_role;
alter default privileges in schema earth grant execute on functions to anon, authenticated, service_role;

-- extensions -----------------------------------------------------------------------------------------
-- Extension functions (st_contains, ...) must stay callable from policies after the global revoke.
alter default privileges in schema extensions grant execute on functions to anon, authenticated, service_role;

-- private --------------------------------------------------------------------------------------------
revoke all on schema private from public, anon, authenticated, service_role;
