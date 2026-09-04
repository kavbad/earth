-- =====================================================================================================
-- Supabase compatibility shim for a plain Postgres.
--
-- Makes a vanilla Postgres 16 look enough like Supabase for `supabase/migrations` to apply and for
-- `supabase/tests` and the local stack (scripts/local-stack) to run: the API roles, the `auth` schema
-- with `auth.uid()` / `auth.jwt()` / `auth.role()` / `auth.email()`, the `extensions` schema, the
-- `storage` schema Storage owns (`buckets`, `objects`, `foldername()`), and Supabase's default
-- privileges on `public` (so migration 0002's revokes are exercised exactly as on hosted Supabase).
--
-- Applied by scripts/db/migrate.ts (recorded as `shim:supabase_shim.sql` in public.earth_migrations,
-- so a re-run of the runner skips it) and by the test harness before the migrations. It is NOT a
-- migration and must never be pushed to a hosted project: every block below is idempotent and returns
-- early on a Supabase-managed database (detected by the `supabase_auth_admin` role together with an
-- existing `auth.uid()`), and scripts/db/migrate.ts skips the file entirely in that case. Applying the
-- file again by hand (psql) on a migrated local database is safe: nothing below re-opens the privilege
-- baseline once 0002 has run (block 5).
--
-- `auth.users` is created only when it does not exist, with a subset of GoTrue's columns and the
-- uniqueness GoTrue enforces (email per non-SSO user, phone). The local stack applies GoTrue's own
-- migrations first (scripts/local-stack/up.sh: prepare-db → `gotrue migrate` → migrate.ts), so there
-- GoTrue owns the real table and block 3 is skipped; conversely GoTrue's migrations apply cleanly on
-- top of this table (every column and index they add is guarded by `if not exists`).
-- supabase/tests/src/gotrue.test.ts proves both orders against GoTrue's real migration files. The shim
-- never alters an existing `auth.users`.
-- =====================================================================================================

-- 1. Roles (cluster-wide; created once per server).
do $shim$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin')
     and to_regprocedure('auth.uid()') is not null then
    raise notice 'supabase_shim: Supabase-managed database detected, skipping roles';
    return;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit password 'postgres';
  end if;
  grant anon, authenticated, service_role to authenticator;

  -- The migrating role (postgres locally) can impersonate the API roles with `set role`, as on Supabase.
  execute format('grant anon, authenticated, service_role to %I', current_user);

  -- Optional superuser used by local tooling that expects Supabase's admin role.
  if (select rolsuper from pg_roles where rolname = current_user)
     and not exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    create role supabase_admin login superuser password 'postgres';
  end if;
end
$shim$;

-- 2. Schemas: auth (GoTrue) and extensions (where Supabase installs extensions).
do $shim$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin')
     and to_regprocedure('auth.uid()') is not null then
    return;
  end if;

  create schema if not exists auth;
  create schema if not exists extensions;
  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema extensions to anon, authenticated, service_role;
end
$shim$;

-- 3. auth.users — only when absent. Compatible subset of GoTrue's columns, its generated
--    `confirmed_at`, and its uniqueness (users_email_partial_key, users_phone_key); never altered here.
do $shim$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin')
     and to_regprocedure('auth.uid()') is not null then
    return;
  end if;

  if to_regclass('auth.users') is null then
    create table auth.users (
      instance_id uuid,
      id uuid not null,
      aud varchar(255),
      role varchar(255),
      email text,
      encrypted_password varchar(255),
      email_confirmed_at timestamptz,
      invited_at timestamptz,
      confirmation_token varchar(255),
      confirmation_sent_at timestamptz,
      recovery_token varchar(255),
      recovery_sent_at timestamptz,
      email_change_token_new varchar(255),
      email_change varchar(255),
      email_change_sent_at timestamptz,
      last_sign_in_at timestamptz,
      raw_app_meta_data jsonb,
      raw_user_meta_data jsonb,
      is_super_admin boolean,
      created_at timestamptz,
      updated_at timestamptz,
      phone text,
      phone_confirmed_at timestamptz,
      confirmed_at timestamptz generated always as (least(email_confirmed_at, phone_confirmed_at)) stored,
      is_sso_user boolean not null default false,
      is_anonymous boolean not null default false,
      deleted_at timestamptz,
      constraint users_pkey primary key (id),
      constraint users_phone_key unique (phone)
    );
    create index users_instance_id_idx on auth.users using btree (instance_id);
    create index users_instance_id_email_idx on auth.users using btree (instance_id, lower(email));
    create unique index users_email_partial_key on auth.users (email) where (is_sso_user = false);
    create index users_is_anonymous_idx on auth.users using btree (is_anonymous);
    alter table auth.users enable row level security;
  end if;
end
$shim$;

-- 4. auth.uid() / auth.role() / auth.email() / auth.jwt() — same definitions as Supabase's (and as
--    GoTrue's own migrations), reading the request.jwt.claims setting PostgREST (and the test harness)
--    populates. `create or replace` so applying this file again is safe whether the functions came
--    from an earlier shim run or from GoTrue; never touched on a managed database.
do $shim$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin')
     and to_regprocedure('auth.uid()') is not null then
    return;
  end if;

  execute $fn$
    create or replace function auth.uid() returns uuid
    language sql stable
    as $body$
      select nullif(
        coalesce(
          nullif(current_setting('request.jwt.claim.sub', true), ''),
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
        ),
        ''
      )::uuid
    $body$
  $fn$;

  execute $fn$
    create or replace function auth.role() returns text
    language sql stable
    as $body$
      select nullif(
        coalesce(
          nullif(current_setting('request.jwt.claim.role', true), ''),
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
        ),
        ''
      )::text
    $body$
  $fn$;

  execute $fn$
    create or replace function auth.email() returns text
    language sql stable
    as $body$
      select nullif(
        coalesce(
          nullif(current_setting('request.jwt.claim.email', true), ''),
          nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'
        ),
        ''
      )::text
    $body$
  $fn$;

  execute $fn$
    create or replace function auth.jwt() returns jsonb
    language sql stable
    as $body$
      select coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
      )::jsonb
    $body$
  $fn$;

  grant execute on function auth.uid() to anon, authenticated, service_role;
  grant execute on function auth.role() to anon, authenticated, service_role;
  grant execute on function auth.email() to anon, authenticated, service_role;
  grant execute on function auth.jwt() to anon, authenticated, service_role;
end
$shim$;

-- 5. Supabase's permissive defaults on `public` (hosted projects grant new tables/functions/sequences
--    to the API roles automatically). Mirrored here so migration 0002's revokes are meaningful locally
--    — and only until 0002 has run: applying this file again to a migrated database must never re-open
--    the privilege baseline.
do $shim$
declare
  baseline_applied boolean;
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin')
     and to_regprocedure('auth.uid()') is not null then
    return;
  end if;

  grant usage on schema public to anon, authenticated, service_role;

  -- SQL `or` does not short-circuit and the whole expression is parsed before it runs, so the ledger
  -- is probed with to_regclass() and only then read, through EXECUTE. Without that this block fails
  -- on any database the runner has not created public.earth_migrations in.
  baseline_applied := exists (select 1 from pg_namespace where nspname = 'earth');
  if not baseline_applied and to_regclass('public.earth_migrations') is not null then
    execute $q$select exists (select 1 from public.earth_migrations where name = '0002_schemas.sql')$q$
      into baseline_applied;
  end if;
  if baseline_applied then
    raise notice 'supabase_shim: privilege baseline (0002) already applied, keeping it';
    return;
  end if;

  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
end
$shim$;

-- 6. `storage` — the schema Supabase's Storage service owns on a hosted project. Without it
--    migration 0997 (`supabase/migrations/0997_storage_buckets.sql`) hits its own guard, returns
--    early, and neither the three buckets nor the five `storage.objects` policies are ever created:
--    the ownership rule every photo, video, voice note and avatar upload depends on would exist only
--    in a file nothing runs (audit DOD-02). This block recreates the subset those policies and the
--    local Storage service (scripts/local-stack/storage.mjs) touch — `storage.buckets`,
--    `storage.objects`, `storage.foldername()/filename()/extension()` — with Supabase's own column
--    names, indexes, grants and row level security, so 0997 applies verbatim and its policies are
--    exercised by `supabase/tests/src/storage/objects.test.ts`.
--
--    Never applied where a real Storage service already owns the schema: a managed database returns
--    at the guard above, and any database that already has `storage` is left untouched.
do $shim$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin')
     and to_regprocedure('auth.uid()') is not null then
    return;
  end if;

  if to_regnamespace('storage') is not null then
    raise notice 'supabase_shim: storage schema already present, leaving it alone';
    return;
  end if;

  create schema storage;
  grant usage on schema storage to anon, authenticated, service_role;

  create table storage.buckets (
    id text not null primary key,
    name text not null,
    owner uuid,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    public boolean default false,
    avif_autodetection boolean default false,
    file_size_limit bigint,
    allowed_mime_types text[],
    owner_id text
  );
  create unique index bname on storage.buckets (name);

  create table storage.objects (
    id uuid not null primary key default gen_random_uuid(),
    bucket_id text references storage.buckets (id),
    name text,
    owner uuid,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    last_accessed_at timestamptz default now(),
    metadata jsonb,
    path_tokens text[] generated always as (string_to_array(name, '/')) stored,
    version text,
    owner_id text,
    user_metadata jsonb
  );
  create unique index bucketid_objname on storage.objects (bucket_id, name);
  create index name_prefix_search on storage.objects (name text_pattern_ops);

  -- Both tables carry RLS on a hosted project: `storage.objects` is governed by 0997's policies and
  -- `storage.buckets` has none, so only the service role (bypassrls) reads bucket configuration.
  alter table storage.buckets enable row level security;
  alter table storage.objects enable row level security;

  -- Supabase's own definitions: `foldername('<human>/<random>.jpg')` is `{<human>}`, which is what
  -- 0997 compares with earth.current_human_id().
  execute $fn$
    create or replace function storage.foldername(name text) returns text[]
    language plpgsql
    as $body$
    declare
      _parts text[];
    begin
      select string_to_array(name, '/') into _parts;
      return _parts[1 : array_length(_parts, 1) - 1];
    end
    $body$
  $fn$;

  execute $fn$
    create or replace function storage.filename(name text) returns text
    language plpgsql
    as $body$
    declare
      _parts text[];
    begin
      select string_to_array(name, '/') into _parts;
      return _parts[array_length(_parts, 1)];
    end
    $body$
  $fn$;

  execute $fn$
    create or replace function storage.extension(name text) returns text
    language plpgsql
    as $body$
    declare
      _parts text[];
      _filename text;
    begin
      select string_to_array(name, '/') into _parts;
      select _parts[array_length(_parts, 1)] into _filename;
      return reverse(split_part(reverse(_filename), '.', 1));
    end
    $body$
  $fn$;

  grant all on storage.buckets to anon, authenticated, service_role;
  grant all on storage.objects to anon, authenticated, service_role;
end
$shim$;
