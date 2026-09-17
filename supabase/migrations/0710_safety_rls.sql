-- 0710 — row level security and grants for the safety tables (DB_API §7; ARCHITECTURE §5, §15).
--
-- `reports`: a reporter reads their own reports — a Human through `earth.current_human_id()` (any
-- status, so a restricted Human still sees what they filed), a Guest through the sessions behind
-- their anonymous credential. Nobody else reads a report (a target is never told who reported
-- them), and there is no client write path: filing goes through `report_create` and the queue is
-- moved only by the service (`report_resolve`, 0720). `service_role` keeps the 0002 defaults.
-- `private.audit_log` (0195) stays owner-only.

-- Whether a Guest session belongs to the calling anonymous credential (own-row reads).
create or replace function earth.guest_session_is_callers(session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select session_id is not null
     and auth.uid() is not null
     and earth.is_anonymous_jwt()
     and exists (
       select 1
         from public.guest_sessions gs
        where gs.id = guest_session_is_callers.session_id
          and gs.auth_user_id = auth.uid()
     )
$$;

grant select on table public.reports to authenticated;
create policy reports_select_own on public.reports
  for select to authenticated
  using (
    (reporter_human_id is not null and reporter_human_id = earth.current_human_id())
    or (reporter_guest_session_id is not null and earth.guest_session_is_callers(reporter_guest_session_id))
  );
