-- 0320 — row level security and grants for the room tables (DB_API §3 "RLS summary"; ARCHITECTURE §5).
--
-- Clients read rooms and participants through the visibility helpers of 0310 and never write:
-- every mutation is an RPC (0330). Guest sessions and room invites carry secrets, so their tables
-- stay closed to the API roles and are read through owner views that filter by the caller and
-- never expose a hash (same pattern as group_invites_view). `service_role` keeps the 0002 defaults.

-- rooms: participants (not removed), group members, the discoverable audience (earth.room_visible_to),
-- visitors for public World Lives, Guests only for their own room.
grant select on table public.rooms to anon, authenticated;
create policy rooms_select_visible on public.rooms
  for select to anon, authenticated
  using (earth.room_readable_by_caller(id));

-- room_participants: own row; live rows of a readable room — publishers to whoever sees the room,
-- viewers only to callers inside the room.
grant select on table public.room_participants to anon, authenticated;
create policy room_participants_select_visible on public.room_participants
  for select to anon, authenticated
  using (earth.room_participant_readable(room_id, human_id, guest_session_id, status, media_state));

-- guest_sessions: no client access to the table (session_secret_hash). A Guest reads their own
-- sessions and moderators the sessions of their room through this view. Only non-inlinable
-- (plpgsql / security definer) earth.* helpers may appear here: an inlined SQL helper would be
-- resolved as the calling role, which has no USAGE on schema earth.
create view public.guest_sessions_view as
  select gs.id, gs.room_id, gs.display_name, gs.room_invite_id, gs.blocked,
         gs.created_at, gs.expires_at, gs.removed_at
    from public.guest_sessions gs
   where (earth.current_role_kind() = 'guest' and gs.auth_user_id = auth.uid())
      or earth.room_is_moderator(gs.room_id, earth.current_human());
grant select on public.guest_sessions_view to authenticated, service_role;

-- room_invites: creator and moderators of the room, never the token hash.
create view public.room_invites_view as
  select ri.id, ri.room_id, ri.created_by_human_id, ri.join_policy_override, ri.expires_at,
         ri.revoked_at, ri.status, ri.use_count, ri.created_at
    from public.room_invites ri
   where earth.current_human() is not null
     and (ri.created_by_human_id = earth.current_human()
          or earth.room_is_moderator(ri.room_id, earth.current_human()));
grant select on public.room_invites_view to authenticated, service_role;

-- room_blocked_fingerprints, notification_cooldowns: no client access at all.
