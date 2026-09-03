-- 0520 — row level security for the location tables (DB_API §5; ARCHITECTURE §5, §15).
--
-- `areas` and `places` keep their read-all policies from 0050 (writes only through RPCs and seeds).
-- `location_shares`: the sharer reads their own rows (any status, so the client can show "Sharing
-- with Weekend Crew · 43 min left" and history); recipients never read the table — they call
-- `location_shares_visible()` (0530), which degrades positions and applies blocks. No client writes.
-- `location_share_positions`: no client access at all; every read goes through the RPC so a
-- position is never handed out without its precision applied.

grant select on table public.location_shares to authenticated;
create policy location_shares_select_own on public.location_shares
  for select to authenticated
  using (human_id = earth.current_human());

revoke all on table public.location_share_positions from anon, authenticated;
