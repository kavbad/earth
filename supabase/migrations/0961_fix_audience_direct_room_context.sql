-- 0961 — fix (audience): a direct conversation names its members to its members only (spec §25–§26,
-- §60, §128 "Private group/chat content never appears in World"; SCREEN 10; DB_API §3
-- `earth.room_context_title`). Reproduced by supabase/tests/src/verify/audience.test.ts.
--
-- 0310 / 0950 `earth.room_context_title` rendered every member of a direct conversation
-- ("Gus + Ivy") to whoever could see its room. Once `room_set_visibility` opened a direct room to
-- friends or World — which takes the consent of the *publishing* Humans only — the other member,
-- who may hold nothing but the `invited` seat `room_start` gives them and never joined, was named
-- to the host's friends, to World, to Guests and to visitors through `live_candidates`,
-- `feed_candidates` (the `live` payload), `room_get` and `room_invite_preview`, while the
-- participant list (`earth.room_json`) already hides every seat that is not publishing. Whom a
-- Human chats with is chat content.
--
-- A direct room's context title now exists for the conversation's members only (the same
-- `earth.is_conversation_member` rule that reads the chat itself); everyone else — friends of a
-- publisher, World viewers, Guests, visitors, the service reading as an anonymous viewer — gets
-- `null`, and every card and pin falls back to the publishers' names (`liveCardTitle`,
-- `earth.map_live_title`, `earth.live_title`), exactly as for standalone rooms. Group rooms are
-- unchanged: the group name is the Live's name by spec §60 ("Weekend Crew is live"). Blocks keep
-- hiding names between members (0950). Signature and grants are those of 0310.

create or replace function earth.room_context_title(p_room_id uuid, p_viewer uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_names text[];
begin
  select * into v_room from public.rooms r where r.id = p_room_id;
  if not found then
    return null;
  end if;
  if v_room.context_type = 'group' then
    return (select g.name from public.groups g where g.id = v_room.context_id);
  end if;
  if v_room.context_type = 'direct' then
    -- The chat is its members' context; nobody else learns who is in it (spec §128).
    if p_viewer is null or not earth.is_conversation_member(v_room.context_id, p_viewer) then
      return null;
    end if;
    select coalesce(array_agg(p.display_name order by cm.joined_at, cm.human_id), '{}'::text[])
      into v_names
      from public.conversation_members cm
      join public.public_identities p on p.human_id = cm.human_id
     where cm.conversation_id = v_room.context_id
       and cm.human_id is distinct from p_viewer
       and not earth.is_blocked_either(p_viewer, cm.human_id);
    return nullif(earth.live_name_list(v_names), '');
  end if;
  return null;
end
$$;
