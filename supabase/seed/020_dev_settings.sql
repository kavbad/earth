-- 020_dev_settings.sql — development settings (ARCHITECTURE §12/§14; DB_API §8, §10).
--
-- Pins `app_settings.environment` to `development` on a seeded database: the setting every
-- fixture-aware surface reads (feed_candidates, public_feed, search, map_objects,
-- earth.identity_visible_to) to decide whether `humans.is_fixture` rows are shown. Migration 0006
-- inserts the same default; this file restores it after an operator changed it locally (for example
-- to rehearse the production behavior with `update public.app_settings set value = 'production'`).
--
-- Pins `web_origin` to the local web app (`http://localhost:3000`, README "Local stack"). Every
-- link the database mints is built from it — group invites (`group_invite_create`), Guest room
-- links (`room_invite_create`, spec §112 `/live/<token>`) and media URLs (0410) — so on a
-- development database it must point at the development web app: with migration 0006's production
-- default (`https://earth.social`) a link shared from a local room opens production, and no local
-- Guest can ever follow it. A hosted environment sets its own origin in `app_settings`; seeds never
-- run there.
--
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
values
  ('environment', 'development'),
  ('web_origin', 'http://localhost:3000')
on conflict (key) do update
  set value = excluded.value,
      updated_at = now();
