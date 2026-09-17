-- 0700 — reports (spec §41, §81–§82, §84; DB_API §7; ARCHITECTURE §5).
--
-- A report is filed by exactly one reporter — a Human (`reporter_human_id`) or a Guest session
-- (`reporter_guest_session_id`) — against one target named by `(target_type, target_id)`. `reason`
-- and `status` are the Postgres enums mirrored in packages/domain/src/enums.ts; `target_type` is
-- checked against `earth.report_target_types()` (the domain's REPORT_TARGET_TYPES); `severity` is a
-- generated column computed by `earth.report_severity(reason)`, which mirrors the domain's
-- REPORT_REASON_HIGH_SEVERITY (spec §82 "High-severity categories receive priority"). Both mirrors
-- are asserted by supabase/tests/src/safety/reports.test.ts.
--
-- `reporter_kind` records who filed the report so the row keeps its meaning when the reporter row is
-- gone (`on delete set null` on both reporter columns); the pair check therefore only forbids the
-- *other* reporter column from being set. Identity columns (reporter kind, target, reason,
-- created_at) never change; the moderation queue only moves `status` / `resolved_at`
-- (`report_resolve`, 0720). Policies and grants live in 0710; nothing here is reachable by
-- anon/authenticated until then.

-- `reports.target_type` values (REPORT_TARGET_TYPES in packages/domain/src/enums.ts, same order).
create or replace function earth.report_target_types()
returns text[]
language sql
immutable
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select array['human', 'post', 'room', 'message', 'guest', 'group']::text[]
$$;

-- Report reasons that receive priority (REPORT_REASON_HIGH_SEVERITY in packages/domain/src/enums.ts).
create or replace function earth.report_high_severity_reasons()
returns public.report_reason[]
language sql
immutable
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select array[
    'threats',
    'exploitation_minor_safety',
    'nonconsensual_imagery',
    'dangerous_location_stalking',
    'violence'
  ]::public.report_reason[]
$$;

-- 'high' for the priority reasons, 'normal' otherwise (spec §82).
create or replace function earth.report_severity(reason public.report_reason)
returns text
language sql
immutable
strict
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select case when reason = any (earth.report_high_severity_reasons()) then 'high' else 'normal' end
$$;

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_kind text not null,
  reporter_human_id uuid references public.humans (id) on delete set null,
  reporter_guest_session_id uuid references public.guest_sessions (id) on delete set null,
  target_type text not null,
  target_id uuid not null,
  reason public.report_reason not null,
  details text,
  status public.report_status not null default 'open',
  severity text generated always as (earth.report_severity(reason)) stored,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint reports_reporter_kind_check check (reporter_kind in ('human', 'guest')),
  constraint reports_reporter_pair_check check (
    (reporter_kind = 'human' and reporter_guest_session_id is null)
    or (reporter_kind = 'guest' and reporter_human_id is null)
  ),
  constraint reports_target_type_check check (target_type = any (earth.report_target_types())),
  constraint reports_details_check check (details is null or length(details) between 1 and 2000),
  constraint reports_severity_check check (severity in ('high', 'normal')),
  constraint reports_resolved_check check ((status in ('resolved', 'dismissed')) = (resolved_at is not null))
);

-- Report history per reporter (reports_mine) and per Guest session.
create index reports_reporter_human_id_idx on public.reports (reporter_human_id, created_at desc)
  where reporter_human_id is not null;
create index reports_reporter_guest_session_id_idx on public.reports (reporter_guest_session_id, created_at desc)
  where reporter_guest_session_id is not null;
-- Everything filed against one object.
create index reports_target_idx on public.reports (target_type, target_id, created_at desc);
-- The moderation queue: open reports, high severity first, oldest first.
create index reports_queue_idx on public.reports (status, severity, created_at);

create trigger reports_touch_updated_at
  before update on public.reports
  for each row execute function earth.touch_updated_at();

-- A report never changes who filed it against what and why; reporter references may only be cleared
-- (by the referential action when the reporter row disappears).
create or replace function earth.reports_before_update_trigger()
returns trigger
language plpgsql
set search_path = public, earth, private, pg_temp
as $$
begin
  if new.id <> old.id
     or new.reporter_kind <> old.reporter_kind
     or new.target_type <> old.target_type
     or new.target_id <> old.target_id
     or new.reason <> old.reason
     or new.created_at <> old.created_at
     or (new.reporter_human_id is not null and new.reporter_human_id is distinct from old.reporter_human_id)
     or (new.reporter_guest_session_id is not null and new.reporter_guest_session_id is distinct from old.reporter_guest_session_id) then
    perform earth.raise('invalid_input', 'report identity columns are immutable');
  end if;
  return new;
end
$$;

revoke execute on function earth.reports_before_update_trigger() from public, anon, authenticated;

create trigger reports_before_update
  before update on public.reports
  for each row execute function earth.reports_before_update_trigger();

alter table public.reports enable row level security;
