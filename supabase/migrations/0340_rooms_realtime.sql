-- 0340 — realtime for rooms (ARCHITECTURE §5 "Realtime", §8 subscribeRoom).
--
-- `rooms` and `room_participants` join the supabase_realtime publication; RLS (0320) governs which
-- change events a subscriber receives. Replica identity FULL so filtered subscriptions
-- (`room_id=eq.<id>`) and delete events carry the columns the policies and filters need.

alter table public.rooms replica identity full;
alter table public.room_participants replica identity full;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'rooms'
  ) then
    alter publication supabase_realtime add table public.rooms;
  end if;
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'room_participants'
  ) then
    alter publication supabase_realtime add table public.room_participants;
  end if;
end
$$;
