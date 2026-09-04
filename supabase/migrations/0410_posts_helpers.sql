-- 0410 — post helpers (DB_API §4 "Visibility"; spec §71–§72, §74; ARCHITECTURE §9).
--
-- `earth.can_view_post(post_id, viewer)` is the canonical permission function for posts
-- (spec §71): author self → true; active only; blocks override everything; audience against the
-- ROOT post (replies never widen, spec §72); neighborhood/city use the viewer's `human_context`
-- (area ids only, never coordinates, spec §74); world reaches visitors while PUBLIC_WORLD_ENABLED.
-- Hides are a feed concern (excluded from candidates, not from a direct fetch) and live in
-- `earth.post_hidden_by`. JSON helpers build `PostViewDto` (`earth.post_json`) and the
-- `FeedCandidate` feature row (`earth.post_candidate_json`) exactly as packages/domain parses them.
-- Read-only helpers are security definer so RLS policies (0420) can evaluate them as any caller.

-- ---------------------------------------------------------------------------------------------------
-- Visibility
-- ---------------------------------------------------------------------------------------------------

-- The root of a thread (the post itself for a root post), or null when unknown.
create or replace function earth.post_root(p_post_id uuid)
returns public.posts
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select r.*
    from public.posts p
    join public.posts r on r.id = coalesce(p.root_post_id, p.id)
   where p.id = p_post_id
$$;

-- The audience rule of DB_API §4 evaluated for a root post and a viewer (an active Human id, or
-- null for visitors / guests / claiming). Friends of the author always qualify.
create or replace function earth.post_audience_matches(p_root public.posts, p_viewer uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_ctx public.human_context%rowtype;
  v_post_city uuid;
begin
  if p_root.id is null then
    return false;
  end if;
  if p_root.audience = 'world' then
    return p_viewer is not null or earth.flag('PUBLIC_WORLD_ENABLED');
  end if;
  if p_viewer is null then
    return false;
  end if;
  if p_viewer = p_root.author_human_id or earth.are_friends(p_viewer, p_root.author_human_id) then
    return true;
  end if;
  if p_root.audience = 'friends' or p_root.area_id is null then
    return false;
  end if;
  select * into v_ctx from public.human_context hc where hc.human_id = p_viewer;
  if not found then
    return false;
  end if;
  if p_root.audience = 'neighborhood' then
    return earth.area_contains(p_root.area_id, v_ctx.current_area_id)
        or earth.area_contains(p_root.area_id, v_ctx.current_city_id);
  end if;
  -- city: the post's city (its area or that area's city) must contain the viewer's current or home context.
  v_post_city := coalesce(earth.area_ancestor_of_type(p_root.area_id, 'city'), p_root.area_id);
  return earth.area_contains(v_post_city, v_ctx.current_area_id)
      or earth.area_contains(v_post_city, v_ctx.current_city_id)
      or earth.area_contains(v_post_city, v_ctx.home_city_id);
end
$$;

-- DB_API §4: whether `viewer_human_id` (an active Human id, or null) may see a post.
create or replace function earth.can_view_post(post_id uuid, viewer_human_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_post public.posts%rowtype;
  v_root public.posts%rowtype;
  v_author public.humans%rowtype;
begin
  if post_id is null then
    return false;
  end if;
  select * into v_post from public.posts p where p.id = can_view_post.post_id;
  if not found then
    return false;
  end if;
  if viewer_human_id is not null and v_post.author_human_id = viewer_human_id then
    return true;
  end if;
  if v_post.status <> 'active' then
    return false;
  end if;
  select * into v_author from public.humans h where h.id = v_post.author_human_id;
  if not found or v_author.status <> 'active' then
    return false;
  end if;
  -- Development fixtures never reach the public in production (DB_API §10, SCREEN 01).
  if v_author.is_fixture and viewer_human_id is null and earth.setting('environment') = 'production' then
    return false;
  end if;
  if earth.is_blocked_either(viewer_human_id, v_post.author_human_id) then
    return false;
  end if;
  if v_post.root_post_id is null then
    v_root := v_post;
  else
    select * into v_root from public.posts r where r.id = v_post.root_post_id;
    if not found or v_root.status <> 'active' then
      return false;
    end if;
    if earth.is_blocked_either(viewer_human_id, v_root.author_human_id) then
      return false;
    end if;
    if viewer_human_id is not null and v_root.author_human_id = viewer_human_id then
      return true;
    end if;
    if not exists (select 1 from public.humans h where h.id = v_root.author_human_id and h.status = 'active') then
      return false;
    end if;
  end if;
  return earth.post_audience_matches(v_root, viewer_human_id);
end
$$;

-- RLS entry point: the service reads everything; everyone else through earth.can_view_post with
-- their active Human (visitors, Guests and claiming Humans read as `null`).
create or replace function earth.post_readable_by_caller(post_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
begin
  if earth.current_role_kind() = 'service' then
    return true;
  end if;
  return earth.can_view_post(post_id, earth.current_human());
end
$$;

-- The viewer hid this post (feeds only; never a direct fetch).
create or replace function earth.post_hidden_by(p_post_id uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select p_viewer is not null and exists (
    select 1 from public.post_hides ph where ph.post_id = p_post_id and ph.human_id = p_viewer
  )
$$;

-- Whether `p_viewer` may reply to the thread rooted at `p_root` (spec §29 reply_policy). The root's
-- author may always continue their own thread; V1 has no mentions, so `mentioned` admits nobody else.
create or replace function earth.post_reply_allowed(p_root public.posts, p_viewer uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
begin
  if p_root.id is null or p_viewer is null then
    return false;
  end if;
  if p_root.author_human_id = p_viewer then
    return true;
  end if;
  return case p_root.reply_policy
           when 'everyone_eligible' then true
           when 'friends' then earth.are_friends(p_viewer, p_root.author_human_id)
           else false
         end;
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- JSON shapes (PostDto, PostMediaDto, PlaceDto, PostViewDto, FeedCandidate)
-- ---------------------------------------------------------------------------------------------------

-- A URL for any media object: the public avatars path when configured, otherwise the server tier's
-- media route (`<web_origin>/api/media/<bucket>/<storage_key>`), which answers with a signed URL.
create or replace function earth.media_url(media_id uuid)
returns text
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select coalesce(
           earth.public_media_url(m.id),
           rtrim(coalesce(nullif(earth.setting('web_origin'), ''), 'https://earth.social'), '/')
             || '/api/media/' || m.bucket || '/' || m.storage_key
         )
    from public.media_objects m
   where m.id = media_url.media_id
$$;

-- `PostDto` for a post row.
create or replace function earth.post_dto_json(p public.posts)
returns jsonb
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
    'id', p.id,
    'authorHumanId', p.author_human_id,
    'type', p.type,
    'text', p.text,
    'audience', p.audience,
    'areaId', p.area_id,
    'placeId', p.place_id,
    'replyPolicy', p.reply_policy,
    'resharePolicy', p.reshare_policy,
    'parentPostId', p.parent_post_id,
    'rootPostId', p.root_post_id,
    'createdAt', to_jsonb(p.created_at),
    'editedAt', to_jsonb(p.edited_at),
    'deletedAt', to_jsonb(p.deleted_at)
  )
$$;

-- `PostMediaDto[]` of a post in display order.
create or replace function earth.post_media_json(p_post_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', pm.id,
           'postId', pm.post_id,
           'mediaType', pm.media_type,
           'url', earth.media_url(pm.media_object_id),
           'width', pm.width,
           'height', pm.height,
           'durationMs', pm.duration_ms,
           'provenance', pm.provenance
         ) order by pm.position, pm.id), '[]'::jsonb)
    from public.post_media pm
   where pm.post_id = p_post_id
$$;

-- `PlaceDto` (spec §38) for a place tag, or null.
create or replace function earth.post_place_json(p_place_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
    'id', pl.id,
    'name', pl.name,
    'areaId', pl.area_id,
    'areaName', earth.area_name(pl.area_id),
    'lat', pl.lat,
    'lng', pl.lng,
    'category', pl.category,
    'visibility', pl.visibility
  )
    from public.places pl
   where pl.id = p_place_id
$$;

-- `PostViewDto` as seen by `p_viewer` (an active Human id or null): row, author identity, counts,
-- the viewer's reaction, place and media. Null when the post does not exist.
create or replace function earth.post_json(post_id uuid, viewer_human_id uuid default null)
returns jsonb
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
    'post', earth.post_dto_json(p),
    'author', earth.identity_json(p.author_human_id),
    'reactionCount', p.reaction_count,
    'replyCount', p.reply_count,
    'myReaction', (select pr.reaction_type from public.post_reactions pr
                    where pr.post_id = p.id and pr.human_id = viewer_human_id and viewer_human_id is not null),
    'place', earth.post_place_json(p.place_id),
    'media', earth.post_media_json(p.id)
  )
    from public.posts p
   where p.id = post_json.post_id
$$;

-- Strongest relationship between a viewer and an author (`CANDIDATE_RELATIONSHIPS`): the viewer's
-- own posts count as `friend`; follow outranks incidental shared-group membership.
create or replace function earth.post_candidate_relationship(p_viewer uuid, p_author uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
begin
  if p_viewer is null or p_author is null then
    return 'none';
  end if;
  if p_viewer = p_author or earth.are_friends(p_viewer, p_author) then
    return 'friend';
  end if;
  if earth.is_following(p_viewer, p_author) then
    return 'follow';
  end if;
  if earth.shared_group_count(p_viewer, p_author) > 0 then
    return 'shared_group';
  end if;
  return 'none';
end
$$;

-- Geographic affinity of an area to the viewer's context (spec §68 "place_affinity"): 1 in the
-- viewer's current neighborhood, 0.6 in the current city, 0.3 in the home city, else 0.
create or replace function earth.area_affinity(p_area_id uuid, p_viewer uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_ctx public.human_context%rowtype;
begin
  if p_area_id is null or p_viewer is null then
    return 0;
  end if;
  select * into v_ctx from public.human_context hc where hc.human_id = p_viewer;
  if not found then
    return 0;
  end if;
  if v_ctx.current_area_id is not null and earth.area_contains(v_ctx.current_area_id, p_area_id) then
    return 1;
  end if;
  if v_ctx.current_city_id is not null and earth.area_contains(v_ctx.current_city_id, p_area_id) then
    return 0.6;
  end if;
  if v_ctx.home_city_id is not null and earth.area_contains(v_ctx.home_city_id, p_area_id) then
    return 0.3;
  end if;
  return 0;
end
$$;

-- One `feed_candidates` row for a post: the `FeedCandidate` features (packages/domain/src/feed/
-- candidates.ts) plus the `post` rendering payload (`PostViewDto`). `p_author_recent` is the
-- author's post count in the candidate window (anti-flood, spec §64); V1 has no interest signals or
-- impressions, so `interestMatch` is 0 and `hasSeen` false.
create or replace function earth.post_candidate_json(p_post_id uuid, p_viewer uuid, p_author_recent integer default 1)
returns jsonb
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object(
    'kind', 'post',
    'id', p.id,
    'authorHumanId', p.author_human_id,
    'createdAt', to_jsonb(p.created_at),
    'startedAt', null,
    'relationship', earth.post_candidate_relationship(p_viewer, p.author_human_id),
    'sharedGroupCount', case when p_viewer is null or p_viewer = p.author_human_id then 0
                             else earth.shared_group_count(p_viewer, p.author_human_id) end,
    'isLive', false,
    'liveParticipantCount', 0,
    'liveFriendCount', 0,
    'reactionCount', p.reaction_count,
    'replyCount', p.reply_count,
    'authorPostCountRecent', greatest(coalesce(p_author_recent, 1), 0),
    'interestMatch', 0,
    'placeAffinity', earth.area_affinity(p.area_id, p_viewer),
    'hasSeen', false,
    'audience', p.audience,
    'areaId', p.area_id,
    'post', earth.post_json(p.id, p_viewer)
  )
    from public.posts p
   where p.id = p_post_id
$$;

-- Room visibility → the post audience it corresponds to for ranking (invited/group/friends/extended → friends).
create or replace function earth.room_visibility_audience(p_visibility public.room_visibility)
returns public.audience
language sql
immutable
strict
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select case p_visibility
           when 'neighborhood' then 'neighborhood'::public.audience
           when 'city' then 'city'::public.audience
           when 'world' then 'world'::public.audience
           else 'friends'::public.audience
         end
$$;

-- One `feed_candidates` row for a Live: features from the `live_candidates` item (`p_item`, the
-- rooms tier's shape, reused as the `live` rendering payload) and the room row.
create or replace function earth.live_candidate_json(p_item jsonb, p_viewer uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_room public.rooms%rowtype;
  v_friend_count integer := 0;
  v_relationship text := 'none';
  v_shared integer := 0;
  v_is_member boolean := false;
  v_human uuid;
  v_relation text;
  v_count integer;
begin
  select * into v_room from public.rooms r where r.id = (p_item ->> 'roomId')::uuid;
  if not found then
    return null;
  end if;
  if p_viewer is not null then
    v_is_member := v_room.context_type = 'group' and earth.is_group_member(v_room.context_id, p_viewer);
    for v_human, v_relation in
      select (participant ->> 'humanId')::uuid, participant ->> 'relationToViewer'
        from jsonb_array_elements(coalesce(p_item -> 'participants', '[]'::jsonb)) as participant
       where participant ->> 'humanId' is not null
    loop
      if v_relation = 'friend' then
        v_friend_count := v_friend_count + 1;
        v_relationship := 'friend';
      elsif v_relationship <> 'friend' and v_human <> p_viewer and earth.is_following(p_viewer, v_human) then
        v_relationship := 'follow';
      elsif v_relationship = 'none' and (v_relation = 'shared_group' or v_is_member) then
        v_relationship := 'shared_group';
      end if;
      if v_human <> p_viewer then
        v_count := earth.shared_group_count(p_viewer, v_human);
        if v_count > v_shared then
          v_shared := v_count;
        end if;
      end if;
    end loop;
    if v_is_member then
      v_shared := greatest(v_shared, 1);
      if v_relationship = 'none' then
        v_relationship := 'shared_group';
      end if;
    end if;
  end if;
  return jsonb_build_object(
    'kind', 'live',
    'id', v_room.id,
    'authorHumanId', null,
    'createdAt', to_jsonb(v_room.created_at),
    'startedAt', to_jsonb(coalesce(v_room.started_at, v_room.created_at)),
    'relationship', v_relationship,
    'sharedGroupCount', v_shared,
    'isLive', true,
    'liveParticipantCount', greatest(coalesce((p_item ->> 'participantCount')::integer, 0), 0),
    'liveFriendCount', v_friend_count,
    'reactionCount', 0,
    'replyCount', 0,
    'authorPostCountRecent', 0,
    'interestMatch', 0,
    'placeAffinity', earth.area_affinity(v_room.area_id, p_viewer),
    'hasSeen', false,
    'audience', earth.room_visibility_audience(v_room.visibility),
    'areaId', v_room.area_id,
    'live', p_item
  );
end
$$;
