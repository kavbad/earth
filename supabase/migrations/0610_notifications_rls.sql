-- 0610 — notifications row level security (DB_API §6; spec §40; ARCHITECTURE §5, §11).
--
-- Clients read their own notification rows (recipient = the caller's active Human) and nothing
-- else: no inserts (rows come only from `earth.notify` inside the RPC that caused them), no
-- deletes, and no direct updates — `read_at` changes go through `notification_mark_read` /
-- `notifications_mark_all_read` (0600), which also rate-limit them. Pending Humans, Guests and
-- Visitors see nothing (`earth.current_human()` is null for them; anon has no grant at all).
-- `notification_cooldowns` is internal to `earth.notify_live` and the service: no client access.
-- `service_role` bypasses RLS and keeps the 0002 grants.

alter table public.notifications enable row level security;
alter table public.notification_cooldowns enable row level security;

revoke all on table public.notifications from anon;
revoke insert, update, delete, truncate, references, trigger on table public.notifications from authenticated;
revoke all on table public.notification_cooldowns from anon, authenticated;

grant select on table public.notifications to authenticated;

drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
  for select to authenticated
  using (recipient_human_id = earth.current_human());

comment on table public.notifications is
  'Spec §40. Created by earth.notify inside the RPC that caused it; read by the recipient; read_at set through notification_mark_read / notifications_mark_all_read; push_sent_at set by the push dispatcher (notifications_unsent / notifications_mark_pushed).';
comment on table public.notification_cooldowns is
  'Live notification dedupe per recipient × room (spec §87, ARCHITECTURE §11). Internal: no client access.';
