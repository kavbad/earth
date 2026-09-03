-- 0720 — safety RPCs (DB_API §7; spec §21, §41, §81–§83; ARCHITECTURE §5).
--
-- Every RPC: security definer, fixed search_path, caller validated through earth.current_role_kind()
-- / earth.assert_human(), mutations rate limited with earth.rate_limit_for_caller, errors only through
-- earth.raise('<code>'), jsonb results shaped like packages/domain/src/dto/safety.ts (camelCase).
-- Parameters keep the contract names; locals are `v_`-prefixed and columns are table-qualified.
--
--   report_create   Humans report Humans, posts, rooms, messages, groups and Guests they can see;
--                   Guests report only their own room and the participants of that room. The target
--                   must exist and be visible to the reporter (`not_visible` otherwise, so a report
--                   can never be used to probe for objects). Rate limited 20/h (Guests 5/h: the
--                   Guest branch asks for 10 and earth.rate_limit_for_caller halves it). Audited.
--   reports_mine    The caller's report history.
--   blocks_list     BlocksListDto: the caller's blocks with the blocked identities.
--   report_resolve  Service only: moves a report through the queue. Audited.

-- ---------------------------------------------------------------------------------------------------
-- Internals
-- ---------------------------------------------------------------------------------------------------

-- `ReportDto` (id, status, createdAt) plus the report's own fields for history screens.
create or replace function earth.report_json(r public.reports)
returns jsonb
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
    'id', r.id,
    'status', r.status,
    'createdAt', to_jsonb(r.created_at),
    'targetType', r.target_type,
    'targetId', r.target_id,
    'reason', r.reason,
    'details', r.details,
    'severity', r.severity,
    'resolvedAt', to_jsonb(r.resolved_at)
  )
$$;

-- Whether Human `p_me` may report Human `p_target` (spec §81 "Every Human profile: Report"): the
-- target exists and is not pending (pending Humans are invisible everywhere), and the reporter can
-- see them somewhere — their public identity, a shared group, a shared conversation, a room both
-- have held a seat in — or has already blocked them (block first, report after is a normal safety
-- flow). Someone who blocked the reporter and shares nothing with them stays invisible.
create or replace function earth.human_reportable_by(p_target uuid, p_me uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
begin
  if p_target is null or p_me is null or p_target = p_me then
    return false;
  end if;
  if not exists (select 1 from public.humans h where h.id = p_target and h.status <> 'pending') then
    return false;
  end if;
  if earth.has_blocked(p_me, p_target) then
    return true;
  end if;
  if earth.identity_visible_to(p_target, p_me) then
    return true;
  end if;
  if earth.shared_group_count(p_me, p_target) > 0 then
    return true;
  end if;
  if exists (
    select 1
      from public.conversation_members a
      join public.conversation_members b on b.conversation_id = a.conversation_id
     where a.human_id = p_me and b.human_id = p_target
  ) then
    return true;
  end if;
  return exists (
    select 1
      from public.room_participants a
      join public.room_participants b on b.room_id = a.room_id
     where a.human_id = p_me and b.human_id = p_target
  );
end
$$;

-- Whether Human `p_me` may report `(p_type, p_id)`: the object exists and is visible to them through
-- the canonical visibility rule of its tier (spec §71). Own objects are handled by report_create.
create or replace function earth.report_target_visible_to_human(p_type text, p_id uuid, p_me uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
begin
  if p_type is null or p_id is null or p_me is null then
    return false;
  end if;
  case p_type
    when 'human' then
      return earth.human_reportable_by(p_id, p_me);
    when 'post' then
      return earth.can_view_post(p_id, p_me);
    when 'room' then
      return earth.room_visible_to(p_id, p_me);
    when 'message' then
      return exists (
        select 1
          from public.messages m
         where m.id = p_id
           and earth.can_view_conversation(m.conversation_id, p_me)
      );
    when 'group' then
      return exists (select 1 from public.groups g where g.id = p_id and g.status = 'active')
         and earth.is_group_member(p_id, p_me);
    when 'guest' then
      return exists (
        select 1
          from public.guest_sessions gs
         where gs.id = p_id
           and earth.room_visible_to(gs.room_id, p_me)
      );
    else
      return false;
  end case;
end
$$;

-- The calling Guest's live session (not removed, not expired: earth.current_guest_session_id) in the
-- room that `(p_type, p_id)` belongs to — the room itself, or a room where the target Human / Guest
-- has held a seat. Null when the target is outside every room the Guest is in.
create or replace function earth.report_guest_session_for_target(p_type text, p_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_room uuid;
  v_session uuid;
begin
  if p_type is null or p_id is null or auth.uid() is null or not earth.is_anonymous_jwt() then
    return null;
  end if;
  if p_type = 'room' then
    return earth.current_guest_session_id(p_id);
  end if;
  if p_type not in ('human', 'guest') then
    return null;
  end if;
  for v_room in
    select distinct rp.room_id
      from public.room_participants rp
     where (p_type = 'human' and rp.human_id = p_id)
        or (p_type = 'guest' and rp.guest_session_id = p_id)
  loop
    v_session := earth.current_guest_session_id(v_room);
    if v_session is not null then
      return v_session;
    end if;
  end loop;
  return null;
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- report_create (spec §41, §81–§83; SCREEN 14/18/22 "Report")
-- ---------------------------------------------------------------------------------------------------

create or replace function public.report_create(
  target_type text,
  target_id uuid,
  reason public.report_reason,
  details text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_type text := target_type;
  v_target uuid := target_id;
  v_reason public.report_reason := reason;
  v_details text := nullif(btrim(coalesce(details, '')), '');
  v_me uuid;
  v_guest uuid;
  v_row public.reports%rowtype;
begin
  if v_kind = 'visitor' then
    perform earth.raise('not_authenticated');
  end if;
  if v_kind not in ('human', 'guest') then
    perform earth.raise('not_a_human');
  end if;
  if v_type is null or not (v_type = any (earth.report_target_types())) then
    perform earth.raise('invalid_input', 'target_type must be one of ' || array_to_string(earth.report_target_types(), ', '));
  end if;
  if v_target is null then
    perform earth.raise('invalid_input', 'target_id is required');
  end if;
  if v_reason is null then
    perform earth.raise('invalid_input', 'reason is required');
  end if;
  if length(v_details) > 2000 then
    perform earth.raise('invalid_input', 'details is longer than 2000 characters');
  end if;

  if v_kind = 'human' then
    v_me := earth.assert_human();
    perform earth.rate_limit_for_caller('report_create', 20, 3600);
    if (v_type = 'human' and v_target = v_me)
       or (v_type = 'post' and exists (select 1 from public.posts p where p.id = v_target and p.author_human_id = v_me))
       or (v_type = 'message' and exists (select 1 from public.messages m where m.id = v_target and m.sender_human_id = v_me)) then
      perform earth.raise('invalid_input', 'you cannot report yourself or your own content');
    end if;
    if not earth.report_target_visible_to_human(v_type, v_target, v_me) then
      perform earth.raise('not_visible');
    end if;
    insert into public.reports (reporter_kind, reporter_human_id, target_type, target_id, reason, details)
    values ('human', v_me, v_type, v_target, v_reason, v_details)
    returning * into v_row;
  else
    -- Guests: half of 10 → 5 per hour (earth.rate_limit_for_caller reduces anonymous budgets).
    perform earth.rate_limit_for_caller('report_create', 10, 3600);
    if v_type not in ('room', 'human', 'guest') then
      perform earth.raise('guest_not_allowed', 'guests may report only their room and its participants');
    end if;
    v_guest := earth.report_guest_session_for_target(v_type, v_target);
    if v_guest is null then
      perform earth.raise('not_visible');
    end if;
    if v_type = 'guest' and v_target = v_guest then
      perform earth.raise('invalid_input', 'you cannot report yourself');
    end if;
    insert into public.reports (reporter_kind, reporter_guest_session_id, target_type, target_id, reason, details)
    values ('guest', v_guest, v_type, v_target, v_reason, v_details)
    returning * into v_row;
  end if;

  perform earth.audit(
    'report_create',
    v_row.target_type,
    v_row.target_id,
    jsonb_build_object('reportId', v_row.id, 'reason', v_row.reason, 'severity', v_row.severity)
  );

  return earth.report_json(v_row);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- reports_mine / blocks_list (SCREEN 25 Settings: safety)
-- ---------------------------------------------------------------------------------------------------

create or replace function public.reports_mine()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
begin
  return jsonb_build_object(
    'reports', coalesce((
      select jsonb_agg(earth.report_json(r) order by r.created_at desc, r.id desc)
        from public.reports r
       where r.reporter_human_id = v_me
    ), '[]'::jsonb)
  );
end
$$;

-- `BlocksListDto`: every Human the caller blocked, newest first, with the blocked identity (null when
-- that Human has no identity) so the list can be rendered and undone. Being blocked is never listed.
create or replace function public.blocks_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
begin
  return jsonb_build_object(
    'blocks', coalesce((
      select jsonb_agg(jsonb_build_object(
               'blockerHumanId', b.blocker_human_id,
               'blockedHumanId', b.blocked_human_id,
               'createdAt', to_jsonb(b.created_at),
               'identity', earth.identity_json(b.blocked_human_id)
             ) order by b.created_at desc, b.blocked_human_id)
        from public.blocks b
       where b.blocker_human_id = v_me
    ), '[]'::jsonb)
  );
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- report_resolve (service; spec §104 "audit sensitive admin actions")
-- ---------------------------------------------------------------------------------------------------

create or replace function public.report_resolve(report_id uuid, status public.report_status)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_id uuid := report_id;
  v_status public.report_status := status;
  v_row public.reports%rowtype;
  v_previous public.report_status;
begin
  if earth.current_role_kind() <> 'service' then
    perform earth.raise('forbidden');
  end if;
  perform earth.rate_limit_for_caller('report_resolve', 600, 3600);
  if v_id is null or v_status is null then
    perform earth.raise('invalid_input', 'report_id and status are required');
  end if;

  select r.* into v_row from public.reports r where r.id = v_id for update;
  if not found then
    perform earth.raise('not_visible');
  end if;
  v_previous := v_row.status;

  update public.reports r
     set status = v_status,
         resolved_at = case
                         when v_status in ('resolved', 'dismissed') then coalesce(r.resolved_at, earth.utc_now())
                         else null
                       end
   where r.id = v_id
  returning r.* into v_row;

  perform earth.audit(
    'report_resolve',
    'report',
    v_row.id,
    jsonb_build_object('status', v_row.status, 'previousStatus', v_previous, 'targetType', v_row.target_type, 'targetId', v_row.target_id)
  );

  return earth.report_json(v_row);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------

revoke execute on function public.report_create(text, uuid, public.report_reason, text) from public;
revoke execute on function public.reports_mine() from public;
revoke execute on function public.blocks_list() from public;
revoke execute on function public.report_resolve(uuid, public.report_status) from public;

grant execute on function public.report_create(text, uuid, public.report_reason, text) to anon, authenticated, service_role;
grant execute on function public.reports_mine() to anon, authenticated, service_role;
grant execute on function public.blocks_list() to anon, authenticated, service_role;
-- Service-only RPC: the role check inside is authoritative; the grant keeps the surface explicit.
grant execute on function public.report_resolve(uuid, public.report_status) to service_role;

-- Internals that reveal relationships or room membership stay owner/service only.
revoke execute on function earth.human_reportable_by(uuid, uuid) from public, anon, authenticated;
revoke execute on function earth.report_target_visible_to_human(text, uuid, uuid) from public, anon, authenticated;
revoke execute on function earth.report_guest_session_for_target(text, uuid) from public, anon, authenticated;
