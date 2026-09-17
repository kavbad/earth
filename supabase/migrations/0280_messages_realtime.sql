-- 0280 — realtime publication for messaging (DB_API §2 "Realtime"; ARCHITECTURE §5, §8).
--
-- `messages`, `message_reactions`, `conversation_members` and `conversations` join the
-- `supabase_realtime` publication; RLS (0260, 0170) governs delivery. Clients filter by
-- `conversation_id`, and a filtered DELETE only carries the columns of the replica identity, so
-- `messages` and `message_reactions` publish the full old row (`conversation_members` already has
-- `conversation_id` in its primary key; `conversations` is filtered by `id`).

alter table public.messages replica identity full;
alter table public.message_reactions replica identity full;

do $$
declare
  v_table text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  foreach v_table in array array['messages', 'message_reactions', 'conversation_members', 'conversations'] loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end
$$;
