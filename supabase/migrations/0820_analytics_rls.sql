-- 0820 — row level security and grants for the analytics tables (DB_API §8; ARCHITECTURE §5).
--
-- `analytics_events`, `rtc_diagnostics` and `metrics_daily` are service-only data: clients write
-- events and diagnostics through the RPCs of 0800 and never read any of the three tables, so no
-- policy exists for `anon`/`authenticated` (RLS is enabled by 0800/0810, and with no policy every
-- row is invisible even if a grant ever slipped in). `service_role` bypasses RLS on Supabase and
-- keeps the 0002 default grants, restated here so the surface is explicit.

revoke all on table public.analytics_events from public, anon, authenticated;
revoke all on table public.rtc_diagnostics from public, anon, authenticated;
revoke all on table public.metrics_daily from public, anon, authenticated;

grant select, insert, update, delete on table public.analytics_events to service_role;
grant select, insert, update, delete on table public.rtc_diagnostics to service_role;
grant select, insert, update, delete on table public.metrics_daily to service_role;
