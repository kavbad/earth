-- 0962 — grants review: a private Place is readable by its creator only, on the table as in the RPCs
-- (spec §38 `places.visibility`, §128 "Exact location is never inferred as public permission";
-- DB_API §4 "`place_id` must be a public place or one the author created", §5; ARCHITECTURE §5).
--
-- 0050 granted SELECT on `public.places` to anon and authenticated behind `places_read_all using
-- (true)`, while every RPC that answers a Place (`place_get`, `places_search`, `place_create`'s
-- reuse, `map_objects`) hides `visibility = 'private'` rows from everyone but their creator. The
-- policy was wider than the rule: `select * from places where visibility = 'private'` through the
-- API as a visitor returned a private Place with its exact `lat` / `lng` and `created_by_human_id`.
-- `supabase/tests/src/verify/grants.test.ts` reproduces this with a private Place created by Alice
-- read as a visitor, as another Human and as a Guest.
--
-- The select policy now mirrors the RPC rule: public Places for every caller, a private Place for
-- the active Human who created it. `service_role` bypasses RLS and keeps the 0050 grant; areas stay
-- read-all (they carry no visibility). Nothing else changes.

drop policy if exists places_read_all on public.places;

create policy places_select_visible on public.places
  for select to anon, authenticated
  using (
    visibility = 'public'
    or (created_by_human_id is not null and created_by_human_id = earth.current_human())
  );

-- Fail loudly if a later range reopens the table.
do $$
begin
  if not exists (
    select 1 from pg_policies p
     where p.schemaname = 'public' and p.tablename = 'places' and p.cmd = 'SELECT'
       and p.qual like '%visibility = ''public''%' and p.qual like '%current_human()%'
  ) then
    raise exception '0962: places select policy does not filter private Places';
  end if;
  if exists (
    select 1 from pg_policies p
     where p.schemaname = 'public' and p.tablename = 'places' and p.cmd = 'SELECT' and p.qual = 'true'
  ) then
    raise exception '0962: a read-all select policy on places is still present';
  end if;
end
$$;
