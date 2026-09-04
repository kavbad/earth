-- 0260 — row level security for messages and reactions (DB_API §2 "RLS summary"; spec §56).
--
-- A message is readable by the conversation's members, except in a direct conversation where a
-- block exists in either direction (spec §56: direct visibility is suppressed; group coexistence is
-- allowed). Reactions follow the message through the denormalized `conversation_id`. There is no
-- client write path: sends, edits, tombstones, reactions and read marks go through the RPCs of 0270.

-- Whether `p_viewer` (an active Human id) may read `p_conversation_id`: member, and not a blocked
-- direct conversation. Null ids never see anything (visitors, guests, claiming Humans).
create or replace function earth.can_view_conversation(p_conversation_id uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select p_conversation_id is not null and p_viewer is not null and exists (
    select 1
      from public.conversations c
      join public.conversation_members cm on cm.conversation_id = c.id and cm.human_id = p_viewer
     where c.id = p_conversation_id
       and not (
         c.type = 'direct'
         and exists (
           select 1
             from public.conversation_members o
            where o.conversation_id = c.id
              and o.human_id <> p_viewer
              and earth.is_blocked_either(o.human_id, p_viewer)
         )
       )
  )
$$;

grant select on table public.messages to authenticated;
create policy messages_select_member on public.messages
  for select to authenticated
  using (earth.can_view_conversation(conversation_id, earth.current_human()));

grant select on table public.message_reactions to authenticated;
create policy message_reactions_select_visible on public.message_reactions
  for select to authenticated
  using (earth.can_view_conversation(conversation_id, earth.current_human()));
