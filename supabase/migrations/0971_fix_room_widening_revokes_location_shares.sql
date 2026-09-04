-- 0971 — fix (location): a `temporary_context` location share ends when its Room is opened up
-- (spec §128 "Exact location is never inferred as public permission", §74–§76; DB_API §5;
-- ARCHITECTURE §10 "Widening is only ever applied by this evaluation").
--
-- `earth.location_share_reaches` (0530:226) admits any active participant of a live Room for a
-- `temporary_context` share, and never asks whether the Room is still the Room the sharer shared
-- with. So a `precise` share made into a `group`-visibility Room kept reaching whoever was in the
-- room after a moderator widened it to `world` + `anyone`: the next stranger to `room_join` read the
-- sharer's exact coordinates out of `location_shares_visible()` (0530:654) and the map's friends
-- layer (0590:243). The sharer was never re-asked, and — because consent for a widening is taken
-- from publishers only (`earth.room_pending_participant_ids`, 0310:1004 filters
-- `media_state <> 'watching'`) — a watching sharer was not even in the consent set.
--
-- A room share is pinned to the Room as it stood when it was made: the moment `rooms.visibility`
-- rises, every live `temporary_context` share addressed to that Room is revoked, exactly as if the
-- sharer had called `location_share_revoke` — the 0500 trigger deletes the stored position with it,
-- the share leaves `location_shares_mine()` (so the sharer's Earth screen stops showing it) and
-- `location_shares_visible()` returns nothing for it, whoever is or later becomes a participant.
-- Sharing again inside the wider Room is a new, explicit decision.
--
-- The revoke hangs off the `rooms` row rather than off the two RPCs, so it covers both widening
-- paths — `public.room_set_visibility` applying a widening immediately (0330:651) and
-- `earth.room_evaluate_pending_visibility` applying a pending one after the last consent (0951:747,
-- reached from room_consent / room_set_media_state / room_leave / room_participant_sync) — and any
-- later one. Narrowing (`new.visibility <= old.visibility`) never widens the audience and leaves
-- shares alone; so does a join-policy change, which can only offer policies the current visibility
-- already allows (`earth.allowed_join_policies`, 0310:656).

-- Revokes every live `temporary_context` share addressed to `p_room_id`. Returns how many ended.
create or replace function earth.location_revoke_room_shares(
  p_room_id uuid,
  p_from public.room_visibility default null,
  p_to public.room_visibility default null
)
returns integer
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_share public.location_shares%rowtype;
  v_count integer := 0;
begin
  if p_room_id is null then
    return 0;
  end if;
  for v_share in
    update public.location_shares ls
       set revoked_at = earth.utc_now()
     where ls.audience_type = 'temporary_context'
       and ls.audience_id = p_room_id
       and ls.revoked_at is null
    returning *
  loop
    v_count := v_count + 1;
    perform earth.audit(
      'location_share_revoke', 'location_share', v_share.id,
      jsonb_build_object(
        'reason', 'room_visibility_widened',
        'roomId', p_room_id,
        'humanId', v_share.human_id,
        'from', p_from,
        'to', p_to
      )
    );
  end loop;
  return v_count;
end
$$;

-- Fires for every write that raises a Room's visibility, whichever path applied it.
create or replace function earth.rooms_widen_revokes_location_shares_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, earth, private, pg_temp
as $$
begin
  if new.visibility > old.visibility then
    perform earth.location_revoke_room_shares(new.id, old.visibility, new.visibility);
  end if;
  return null;
end
$$;

revoke execute on function earth.location_revoke_room_shares(uuid, public.room_visibility, public.room_visibility)
  from public, anon, authenticated;
revoke execute on function earth.rooms_widen_revokes_location_shares_trigger() from public, anon, authenticated;

create trigger rooms_widen_revokes_location_shares
  after update of visibility on public.rooms
  for each row
  when (new.visibility > old.visibility)
  execute function earth.rooms_widen_revokes_location_shares_trigger();

-- Fail loudly if a later range drops what this fix depends on.
do $$
begin
  if to_regprocedure('earth.location_revoke_room_shares(uuid, public.room_visibility, public.room_visibility)') is null
     or to_regprocedure('earth.rooms_widen_revokes_location_shares_trigger()') is null then
    raise exception '0971: location share revoke primitives missing';
  end if;
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.rooms'::regclass
       and t.tgname = 'rooms_widen_revokes_location_shares'
       and not t.tgisinternal
  ) then
    raise exception '0971: trigger rooms_widen_revokes_location_shares on public.rooms is missing';
  end if;
end
$$;
