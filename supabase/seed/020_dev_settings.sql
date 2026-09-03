-- 020_dev_settings.sql — development settings (ARCHITECTURE §12/§14; DB_API §8, §10).
--
-- Pins `app_settings.environment` to `development` on a seeded database: the setting every
-- fixture-aware surface reads (feed_candidates, public_feed, search, map_objects,
-- earth.identity_visible_to) to decide whether `humans.is_fixture` rows are shown. Migration 0006
-- inserts the same default; this file restores it after an operator changed it locally (for example
-- to rehearse the production behavior with `update public.app_settings set value = 'production'`).
-- Feature flags are never touched by the seeds. Refuses to run on a production database, like every
-- seed file (a production database keeps `environment = 'production'` and never receives fixtures).

do $guard$
begin
  if coalesce(earth.setting('environment'), '') = 'production' then
    raise exception 'supabase/seed/020_dev_settings.sql refused: app_settings.environment = production';
  end if;
end
$guard$;

insert into public.app_settings (key, value)
values ('environment', 'development')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
