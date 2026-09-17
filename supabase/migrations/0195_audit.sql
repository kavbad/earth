-- 0195 — audit log primitive (spec §104; DB_API §7 "private.audit_log").
--
-- Sensitive actions (claims, blocks, moderator removals, review resolutions, room ends) append a row
-- through `earth.audit(...)` from inside the RPC that performs them. The table is owner-only; the
-- function is executable by security definer RPCs (owner) and the service role, never by clients.

create table private.audit_log (
  id bigint generated always as identity primary key,
  actor_human_id uuid,
  actor_role text not null,
  actor_auth_user_id uuid,
  action text not null,
  target_type text not null,
  target_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint audit_log_action_check check (action ~ '^[a-z][a-z0-9_.]*$'),
  constraint audit_log_details_check check (jsonb_typeof(details) = 'object')
);

create index audit_log_actor_human_id_idx on private.audit_log (actor_human_id);
create index audit_log_target_idx on private.audit_log (target_type, target_id);
create index audit_log_created_at_idx on private.audit_log (created_at);

alter table private.audit_log enable row level security;
revoke all on table private.audit_log from public, anon, authenticated, service_role;

create or replace function earth.audit(
  action text,
  target_type text,
  target_id uuid,
  details jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_id bigint;
begin
  if action is null or action = '' or target_type is null or target_type = '' then
    perform earth.raise('invalid_input', 'earth.audit: action and target_type are required');
  end if;
  insert into private.audit_log (actor_human_id, actor_role, actor_auth_user_id, action, target_type, target_id, details)
  values (
    earth.current_human_id(),
    earth.current_role_kind(),
    auth.uid(),
    action,
    target_type,
    target_id,
    coalesce(details, '{}'::jsonb)
  )
  returning id into v_id;
  return v_id;
end
$$;

revoke execute on function earth.audit(text, text, uuid, jsonb) from public, anon, authenticated;
