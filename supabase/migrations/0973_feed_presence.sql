-- 0973 — SCREEN 02 presence row: `public.feed_presence()` (spec PART VI SCREEN 02 "Presence row:
-- render only when there is meaningful state. Examples: 'Xavier + Maya live', 'Weekend Crew · 3
-- active', 'Sarah nearby'. Do not show empty placeholders."; DB_API §4; ARCHITECTURE §9).
--
-- The row's three item kinds are `PRESENCE_ITEM_TYPES` (`friends_live`, `group_active`,
-- `friend_nearby`) and its card is `PresenceCardDto`, but nothing emitted one: `feed_candidates`
-- (0430:412) returns ranked `post` / `live` candidates only, and the domain says so
-- (`FEED_CANDIDATE_KINDS = ['post', 'live']` — "presence rows are assembled by the server, not
-- ranked"). So `feed.view.presence` was always empty and both clients' `<PresenceRow>` was dead
-- code. This function is the missing source; `packages/server/src/feed/presence.ts` turns it into
-- the card and `GET /api/feed` prepends it to the first page.
--
-- It returns the three sources raw, never rendered copy: naming (spec §60 — active publishers
-- only, the viewer excluded, most relevant first) and the labels live once, in
-- `packages/domain/src/rooms/naming.ts` and `packages/domain/src/feed/presence.ts`.
--
--   liveRooms      `live_candidates('friends')` verbatim, so the rooms tier keeps deciding what a
--                  viewer may discover (`earth.room_visible_to`, 0998 context titles); the server
--                  keeps the rooms a friend is actually publishing in.
--   activeGroups   the caller's own named groups whose *other* members are pinging
--                  `human_presence.active_conversation_id` at the group's conversation inside the
--                  presence window — "3 active", the people in the group right now.
--   nearbyFriends  friends whose `human_context.current_area_id` is the caller's current area and
--                  who are present in the same window. Area-level only, mutual friends only: this
--                  is the same neighborhood-scale fact the Neighborhood radius already shows
--                  ("friends nearby", spec §66), never a position — SCREEN 03 "never indicate
--                  someone's exact location", spec §128.
--
-- Blocks (either direction), non-active Humans and — in production — fixture Humans are excluded
-- everywhere. Non-Humans (visitors, Guests, claiming credentials) get an empty result rather than
-- an error: the presence row is decoration around a feed they may still read.
--
-- The window mirrors `PRESENCE_ROW_WINDOW_MINUTES` in `packages/domain/src/constants.ts`. It is
-- deliberately wider than `PRESENCE_ACTIVE_WINDOW_SECONDS` (30s), which only suppresses a push the
-- reader is about to see anyway.

create or replace function public.feed_presence()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_me uuid;
  v_now timestamptz := earth.utc_now();
  -- PRESENCE_ROW_WINDOW_MINUTES.
  v_window constant interval := interval '10 minutes';
  -- Faces / ids sampled per item (NAMED_PARTICIPANTS_MAX).
  v_sample constant integer := 3;
  -- Items of one kind; the row is capped again in the server tier (PRESENCE_ITEMS_MAX).
  v_limit constant integer := 10;
  v_production boolean := coalesce(earth.setting('environment'), '') = 'production';
  v_area uuid;
  v_rooms jsonb := '[]'::jsonb;
  v_groups jsonb := '[]'::jsonb;
  v_nearby jsonb := '[]'::jsonb;
begin
  if v_kind = 'human' then
    v_me := earth.current_human();
  end if;
  if v_me is null then
    return jsonb_build_object(
      'liveRooms', '[]'::jsonb,
      'activeGroups', '[]'::jsonb,
      'nearbyFriends', '[]'::jsonb
    );
  end if;

  -- Friends live.
  select coalesce(jsonb_agg(item order by item ->> 'startedAt' desc, item ->> 'roomId'), '[]'::jsonb)
    into v_rooms
    from jsonb_array_elements(
           coalesce(
             public.live_candidates('friends'::public.audience, null, v_limit) -> 'candidates',
             '[]'::jsonb
           )
         ) as item
    join public.rooms r on r.id = (item ->> 'roomId')::uuid
    join public.humans h on h.id = r.initiated_by_human_id
   where not (v_production and h.is_fixture);

  -- Groups of the caller's with members active in the group's conversation right now.
  with mine as (
    select g.id as group_id, g.name as group_name, c.id as conversation_id
      from public.groups g
      join public.conversations c on c.group_id = g.id
      join public.group_members gm
        on gm.group_id = g.id and gm.human_id = v_me and gm.status = 'active'
     where g.status = 'active'
       and g.name is not null
  ),
  active as (
    select m.group_id,
           m.group_name,
           m.conversation_id,
           gm.human_id,
           earth.public_media_url(pi.avatar_media_id) as avatar_url,
           row_number() over (
             partition by m.group_id order by hp.last_active_at desc, gm.human_id
           ) as rn,
           count(*) over (partition by m.group_id)::integer as active_count
      from mine m
      join public.group_members gm
        on gm.group_id = m.group_id and gm.status = 'active' and gm.human_id <> v_me
      join public.humans hm on hm.id = gm.human_id and hm.status = 'active'
      join public.human_presence hp on hp.human_id = gm.human_id
      left join public.public_identities pi on pi.human_id = gm.human_id
     where not (v_production and hm.is_fixture)
       and hp.active_conversation_id = m.conversation_id
       and hp.last_active_at >= v_now - v_window
       and hp.last_active_at <= v_now
       and not earth.is_blocked_either(v_me, gm.human_id)
  )
  select coalesce(
           jsonb_agg(g.row_json order by g.active_count desc, g.group_name, g.group_id),
           '[]'::jsonb
         )
    into v_groups
    from (
      select a.group_id,
             a.group_name,
             a.active_count,
             jsonb_build_object(
               'groupId', a.group_id,
               'groupName', a.group_name,
               'conversationId', a.conversation_id,
               'activeCount', a.active_count,
               'humanIds', coalesce(
                 jsonb_agg(to_jsonb(a.human_id) order by a.rn) filter (where a.rn <= v_sample),
                 '[]'::jsonb
               ),
               'avatarUrls', coalesce(
                 jsonb_agg(to_jsonb(a.avatar_url) order by a.rn)
                   filter (where a.rn <= v_sample and a.avatar_url is not null),
                 '[]'::jsonb
               )
             ) as row_json
        from active a
       group by a.group_id, a.group_name, a.conversation_id, a.active_count
       order by a.active_count desc, a.group_name, a.group_id
       limit v_limit
    ) g;

  -- Friends in the caller's current area.
  select hc.current_area_id into v_area from public.human_context hc where hc.human_id = v_me;
  if v_area is not null then
    select coalesce(jsonb_agg(n.row_json order by n.last_active_at desc, n.human_id), '[]'::jsonb)
      into v_nearby
      from (
        select f.id as human_id,
               hp.last_active_at,
               jsonb_build_object(
                 'humanId', f.id,
                 'displayName', pi.display_name,
                 'avatarUrl', earth.public_media_url(pi.avatar_media_id)
               ) as row_json
          from public.humans f
          join public.public_identities pi on pi.human_id = f.id
          join public.human_context fc on fc.human_id = f.id
          join public.human_presence hp on hp.human_id = f.id
         where f.id <> v_me
           and f.status = 'active'
           and not (v_production and f.is_fixture)
           and earth.are_friends(v_me, f.id)
           and fc.current_area_id = v_area
           and hp.last_active_at >= v_now - v_window
           and hp.last_active_at <= v_now
           and not earth.is_blocked_either(v_me, f.id)
         order by hp.last_active_at desc, f.id
         limit v_limit
      ) n;
  end if;

  return jsonb_build_object(
    'liveRooms', v_rooms,
    'activeGroups', v_groups,
    'nearbyFriends', v_nearby
  );
end
$$;

-- Granted like every other client RPC; the function itself is the gate, and it answers a caller
-- with no active Human (visitor, Guest, claiming credential) with an empty row rather than an
-- error. `GET /api/feed` only ever reads it for a caller with a bearer.
revoke execute on function public.feed_presence() from public;
grant execute on function public.feed_presence() to anon, authenticated, service_role;
