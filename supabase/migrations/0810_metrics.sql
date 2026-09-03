-- 0810 — first-party daily metrics (spec §13, PART XVII §98–§101; DB_API §8).
--
-- `metrics_daily` persists the mission-critical network metrics that are derivable from first-party
-- tables and `analytics_events`, so Earth is never entirely dependent on the analytics vendor.
-- `metrics_compute_daily(day)` (service; `POST /api/internal/metrics/daily`) recomputes every metric
-- for one UTC day and upserts per `(day, metric, dimensions)`, so a re-run is idempotent and a
-- cohort metric matures in place (`group_activation_rate` for cohort `day - 7` is final when day
-- `day` is computed; the same-day cohort row is provisional). Cohort metrics carry the cohort in
-- `dimensions` (`{"cohort": "YYYY-MM-DD"}`); every other row has `{}`. `details` keeps the
-- numerator/denominator so a dashboard can show "3 of 12". `value` is null when a ratio has no
-- denominator. Only persistent groups (spec §22) count as groups; temporary groups are chats.
--
-- `rooms.max_visibility` records the widest visibility a room ever reached (trigger-maintained,
-- monotonic), the source of "rooms opened beyond group" — `visibility` alone forgets a Live that
-- was narrowed back. Indexes on the day-range scans this job runs are added here.

-- ---------------------------------------------------------------------------------------------------
-- rooms.max_visibility
-- ---------------------------------------------------------------------------------------------------

alter table public.rooms add column max_visibility public.room_visibility;
update public.rooms set max_visibility = visibility;
alter table public.rooms
  alter column max_visibility set not null,
  alter column max_visibility set default 'invited',
  add constraint rooms_max_visibility_check check (max_visibility >= visibility);

-- Never below the current visibility, never lowered.
create or replace function earth.rooms_track_max_visibility_trigger()
returns trigger
language plpgsql
set search_path = public, earth, private, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.max_visibility := greatest(coalesce(new.max_visibility, new.visibility), new.visibility);
  else
    new.max_visibility := greatest(old.max_visibility, new.visibility);
  end if;
  return new;
end
$$;

create trigger rooms_track_max_visibility
  before insert or update of visibility, max_visibility on public.rooms
  for each row execute function earth.rooms_track_max_visibility_trigger();

-- ---------------------------------------------------------------------------------------------------
-- Day-range scans of the daily job
-- ---------------------------------------------------------------------------------------------------

create index humans_claimed_at_idx on public.humans (claimed_at) where claimed_at is not null;
create index groups_kind_created_at_idx on public.groups (kind, created_at);
create index messages_created_at_idx on public.messages (created_at);
create index rooms_created_at_idx on public.rooms (created_at);
create index guest_sessions_created_at_idx on public.guest_sessions (created_at);

-- ---------------------------------------------------------------------------------------------------
-- metrics_daily
-- ---------------------------------------------------------------------------------------------------

create table public.metrics_daily (
  day date not null,
  metric text not null,
  dimensions jsonb not null default '{}'::jsonb,
  value numeric,
  details jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  constraint metrics_daily_pkey primary key (day, metric, dimensions),
  constraint metrics_daily_metric_check check (metric ~ '^[a-z][a-z0-9_]*$'),
  constraint metrics_daily_dimensions_check check (jsonb_typeof(dimensions) = 'object'),
  constraint metrics_daily_details_check check (jsonb_typeof(details) = 'object')
);

create index metrics_daily_metric_day_idx on public.metrics_daily (metric, day);

alter table public.metrics_daily enable row level security;

-- Upsert one row and return it as `{ metric, dimensions, value }`.
create or replace function earth.metrics_upsert(
  p_day date,
  p_metric text,
  p_dimensions jsonb,
  p_value numeric,
  p_details jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  -- Counts stay unscaled integers; ratios are rounded to six decimals.
  v_value numeric := case
                       when p_value is null then null
                       when p_value = trunc(p_value) then trunc(p_value)
                       else round(p_value, 6)
                     end;
begin
  insert into public.metrics_daily as md (day, metric, dimensions, value, details, computed_at)
  values (p_day, p_metric, coalesce(p_dimensions, '{}'::jsonb), v_value, coalesce(p_details, '{}'::jsonb), earth.utc_now())
  on conflict (day, metric, dimensions) do update
    set value = excluded.value,
        details = excluded.details,
        computed_at = excluded.computed_at;
  return jsonb_build_object('metric', p_metric, 'dimensions', coalesce(p_dimensions, '{}'::jsonb), 'value', v_value);
end
$$;

-- Numerator ÷ denominator, null when the denominator is zero.
create or replace function earth.metrics_ratio(p_numerator numeric, p_denominator numeric)
returns numeric
language sql
immutable
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select case when coalesce(p_denominator, 0) = 0 then null else p_numerator / p_denominator end
$$;

-- Midnight UTC of a calendar day, whatever the session time zone.
create or replace function earth.utc_day_start(p_day date)
returns timestamptz
language sql
immutable
strict
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select (p_day::timestamp) at time zone 'UTC'
$$;

-- ---------------------------------------------------------------------------------------------------
-- metrics_compute_daily(day date) — service only (DB_API §8)
-- ---------------------------------------------------------------------------------------------------
-- Metrics written for `day` (UTC window [day, day + 1)):
--   group_seed_rate            Humans claimed that day ÷ distinct Visitors with `claim_started` that
--                              day (anonymous visitor id, falling back to the Human or Guest of the event)
--   humans_per_seed            Humans claimed via join_group ÷ Humans claimed via start_group
--   group_activation_rate      groups created on the cohort day reaching ≥ 3 active members by the end
--                              of cohort + 7; cohorts `day` (provisional) and `day - 7` (final);
--                              dimensions {cohort}
--   second_group_rate          Humans claimed on `day - 30` holding ≥ 2 active memberships at the end
--                              of `day`; dimensions {cohort}
--   messages_per_active_group  non-system messages in group conversations ÷ groups with ≥ 1 such message
--   groups_active_3_days_week  groups with messages on ≥ 3 distinct days in [day - 6, day]
--   rooms_started              rooms created
--   rooms_opened_beyond_group  rooms created whose visibility ever reached ≥ friends (max_visibility)
--   guest_joins                Guest sessions created
--   repeat_guests              anonymous auth users with ≥ 2 Guest sessions in [day - 6, day]
--   guest_to_human_conversions Humans claimed whose credential held a Guest session before claiming,
--                              or whose `human_claimed` event names a real Guest session
--   scope_switches             `scope_changed` events
-- Returns `{ day, computedAt, metrics: [{ metric, dimensions, value }] }`.
create or replace function public.metrics_compute_daily(day date)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_now timestamptz := earth.utc_now();
  v_today date := (v_now at time zone 'UTC')::date;
  v_start timestamptz;
  v_end timestamptz;
  v_week_start timestamptz;
  v_rows jsonb := '[]'::jsonb;
  v_num numeric;
  v_den numeric;
  v_extra numeric;
  v_detail jsonb;
  v_cohort date;
  v_cohort_start timestamptz;
  v_cohort_end timestamptz;
  v_cutoff timestamptz;
begin
  if earth.current_role_kind() <> 'service' then
    perform earth.raise('forbidden');
  end if;
  if day is null then
    perform earth.raise('invalid_input', 'day is required');
  end if;
  if day > v_today then
    perform earth.raise('invalid_input', 'day must not be in the future');
  end if;

  v_start := earth.utc_day_start(day);
  v_end := v_start + interval '1 day';
  v_week_start := v_start - interval '6 days';

  -- group_seed_rate ---------------------------------------------------------------------------------
  select count(*) into v_num
    from public.humans h
   where h.claimed_at >= v_start and h.claimed_at < v_end;
  select count(distinct coalesce(
           e.anonymous_visitor_id::text,
           'human:' || e.human_id::text,
           'guest:' || e.guest_session_id::text
         ))
    into v_den
    from public.analytics_events e
   where e.name = 'claim_started'
     and e.created_at >= v_start and e.created_at < v_end
     and (e.anonymous_visitor_id is not null or e.human_id is not null or e.guest_session_id is not null);
  v_rows := v_rows || earth.metrics_upsert(day, 'group_seed_rate', '{}'::jsonb,
    earth.metrics_ratio(v_num, v_den),
    jsonb_build_object('humansClaimed', v_num, 'claimIntentVisitors', v_den));

  -- humans_per_seed ---------------------------------------------------------------------------------
  select count(*) filter (where h.claim_intent = 'join_group'),
         count(*) filter (where h.claim_intent = 'start_group')
    into v_num, v_den
    from public.humans h
   where h.claimed_at >= v_start and h.claimed_at < v_end;
  v_rows := v_rows || earth.metrics_upsert(day, 'humans_per_seed', '{}'::jsonb,
    earth.metrics_ratio(v_num, v_den),
    jsonb_build_object('joined', v_num, 'started', v_den));

  -- group_activation_rate (cohorts day and day - 7) --------------------------------------------------
  foreach v_cohort in array array[day, day - 7] loop
    v_cohort_start := earth.utc_day_start(v_cohort);
    v_cohort_end := v_cohort_start + interval '1 day';
    v_cutoff := v_cohort_start + interval '8 days';
    select count(*) filter (where s.active_members >= 3), count(*)
      into v_num, v_den
      from (
        select (select count(*)
                  from public.group_members gm
                 where gm.group_id = g.id
                   and gm.joined_at < v_cutoff
                   and (gm.left_at is null or gm.left_at >= v_cutoff)) as active_members
          from public.groups g
         where g.kind = 'persistent'
           and g.created_at >= v_cohort_start and g.created_at < v_cohort_end
      ) as s;
    v_rows := v_rows || earth.metrics_upsert(day, 'group_activation_rate',
      jsonb_build_object('cohort', v_cohort),
      earth.metrics_ratio(v_num, v_den),
      jsonb_build_object('groupsCreated', v_den, 'groupsActivated', v_num,
                         'cutoff', to_jsonb(v_cutoff), 'final', v_cutoff <= v_now));
  end loop;

  -- second_group_rate (cohort day - 30) ---------------------------------------------------------------
  v_cohort := day - 30;
  v_cohort_start := earth.utc_day_start(v_cohort);
  v_cohort_end := v_cohort_start + interval '1 day';
  select count(*) filter (where s.memberships >= 2), count(*)
    into v_num, v_den
    from (
      select (select count(*)
                from public.group_members gm
                join public.groups g on g.id = gm.group_id
               where gm.human_id = h.id
                 and g.kind = 'persistent'
                 and gm.joined_at < v_end
                 and (gm.left_at is null or gm.left_at >= v_end)) as memberships
        from public.humans h
       where h.claimed_at >= v_cohort_start and h.claimed_at < v_cohort_end
    ) as s;
  v_rows := v_rows || earth.metrics_upsert(day, 'second_group_rate',
    jsonb_build_object('cohort', v_cohort),
    earth.metrics_ratio(v_num, v_den),
    jsonb_build_object('humansClaimed', v_den, 'withSecondGroup', v_num));

  -- messages_per_active_group -------------------------------------------------------------------------
  select count(*), count(distinct c.group_id)
    into v_num, v_den
    from public.messages m
    join public.conversations c on c.id = m.conversation_id
    join public.groups g on g.id = c.group_id
   where c.type = 'group'
     and g.kind = 'persistent'
     and m.type <> 'system'
     and m.created_at >= v_start and m.created_at < v_end;
  v_rows := v_rows || earth.metrics_upsert(day, 'messages_per_active_group', '{}'::jsonb,
    earth.metrics_ratio(v_num, v_den),
    jsonb_build_object('messages', v_num, 'activeGroups', v_den));

  -- groups_active_3_days_week -------------------------------------------------------------------------
  select count(*) into v_num
    from (
      select c.group_id
        from public.messages m
        join public.conversations c on c.id = m.conversation_id
        join public.groups g on g.id = c.group_id
       where c.type = 'group'
         and g.kind = 'persistent'
         and m.type <> 'system'
         and m.created_at >= v_week_start and m.created_at < v_end
       group by c.group_id
      having count(distinct (m.created_at at time zone 'UTC')::date) >= 3
    ) as s;
  v_rows := v_rows || earth.metrics_upsert(day, 'groups_active_3_days_week', '{}'::jsonb, v_num,
    jsonb_build_object('windowStart', to_jsonb(day - 6), 'windowEnd', to_jsonb(day), 'groups', v_num));

  -- rooms_started / rooms_opened_beyond_group ---------------------------------------------------------
  select count(*),
         count(*) filter (where r.max_visibility >= 'friends'),
         count(*) filter (where r.max_visibility >= 'friends' and r.context_type = 'group')
    into v_num, v_den, v_extra
    from public.rooms r
   where r.created_at >= v_start and r.created_at < v_end;
  select coalesce(jsonb_object_agg(b.context_type, b.n), '{}'::jsonb) into v_detail
    from (
      select r.context_type::text as context_type, count(*) as n
        from public.rooms r
       where r.created_at >= v_start and r.created_at < v_end
       group by r.context_type
    ) as b;
  v_rows := v_rows || earth.metrics_upsert(day, 'rooms_started', '{}'::jsonb, v_num,
    jsonb_build_object('rooms', v_num, 'byContextType', v_detail));
  v_rows := v_rows || earth.metrics_upsert(day, 'rooms_opened_beyond_group', '{}'::jsonb, v_den,
    jsonb_build_object('rooms', v_den, 'groupRooms', v_extra, 'roomsStarted', v_num));

  -- guest_joins ---------------------------------------------------------------------------------------
  select count(*), count(distinct gs.room_id)
    into v_num, v_den
    from public.guest_sessions gs
   where gs.created_at >= v_start and gs.created_at < v_end;
  v_rows := v_rows || earth.metrics_upsert(day, 'guest_joins', '{}'::jsonb, v_num,
    jsonb_build_object('guestSessions', v_num, 'rooms', v_den));

  -- repeat_guests (trailing week) ---------------------------------------------------------------------
  select count(*) filter (where s.sessions >= 2), count(*)
    into v_num, v_den
    from (
      select gs.auth_user_id, count(*) as sessions
        from public.guest_sessions gs
       where gs.auth_user_id is not null
         and gs.created_at >= v_week_start and gs.created_at < v_end
       group by gs.auth_user_id
    ) as s;
  v_rows := v_rows || earth.metrics_upsert(day, 'repeat_guests', '{}'::jsonb, v_num,
    jsonb_build_object('windowStart', to_jsonb(day - 6), 'windowEnd', to_jsonb(day),
                       'repeatGuests', v_num, 'guestsInWindow', v_den));

  -- guest_to_human_conversions ------------------------------------------------------------------------
  select count(*) filter (where s.converted), count(*)
    into v_num, v_den
    from (
      select exists (
               select 1 from public.guest_sessions gs
                where gs.auth_user_id = h.auth_user_id and gs.created_at < h.claimed_at
             ) or exists (
               select 1
                 from public.analytics_events e
                 join public.guest_sessions gs on gs.id = earth.try_uuid(e.properties ->> 'guestSessionId')
                where e.name = 'human_claimed' and e.human_id = h.id
             ) as converted
        from public.humans h
       where h.claimed_at >= v_start and h.claimed_at < v_end
    ) as s;
  v_rows := v_rows || earth.metrics_upsert(day, 'guest_to_human_conversions', '{}'::jsonb, v_num,
    jsonb_build_object('conversions', v_num, 'humansClaimed', v_den));

  -- scope_switches ------------------------------------------------------------------------------------
  select count(*), count(distinct e.human_id)
    into v_num, v_den
    from public.analytics_events e
   where e.name = 'scope_changed'
     and e.created_at >= v_start and e.created_at < v_end;
  v_rows := v_rows || earth.metrics_upsert(day, 'scope_switches', '{}'::jsonb, v_num,
    jsonb_build_object('switches', v_num, 'distinctHumans', v_den));

  return jsonb_build_object('day', to_jsonb(day), 'computedAt', to_jsonb(v_now), 'metrics', v_rows);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------

revoke execute on function public.metrics_compute_daily(date) from public;
-- Service-only: the role check inside is authoritative; the grant keeps the surface explicit.
grant execute on function public.metrics_compute_daily(date) to service_role;

revoke execute on function earth.metrics_upsert(date, text, jsonb, numeric, jsonb) from public, anon, authenticated;
