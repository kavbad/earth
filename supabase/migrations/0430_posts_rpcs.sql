-- 0430 — post and feed RPCs (DB_API §4 "RPCs"; spec §29–§31, §63–§70, §72, §83; SCREEN 06–07;
-- ARCHITECTURE §9).
--
-- post_create validates content, never stores coordinates (area ids come from `human_context` or an
-- explicit area, places are explicit tags), narrows a reply's audience to the root's and honours the
-- root's reply policy. feed_candidates returns the candidate pools of spec §64–§69 already
-- permission-filtered (earth.can_view_post, blocks, hides, fixtures in production) as
-- `FeedCandidate` feature rows plus rendering payloads; Lives are the rooms tier's own
-- `live_candidates` output (its visibility logic is not duplicated). Ranking lives in the server tier.

-- ---------------------------------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------------------------------

-- The post when the viewer may see it, else raises `post_not_found` (existence is never revealed).
create or replace function earth.assert_post_visible(p_post_id uuid, p_viewer uuid)
returns public.posts
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_post public.posts%rowtype;
begin
  if p_post_id is null then
    perform earth.raise('invalid_input', 'post_id is required');
  end if;
  select * into v_post from public.posts p where p.id = p_post_id;
  if not found or not earth.can_view_post(v_post.id, p_viewer) then
    perform earth.raise('post_not_found');
  end if;
  return v_post;
end
$$;

-- The caller's active Human, or null for visitors, Guests, claiming Humans and the service.
create or replace function earth.viewer_human()
returns uuid
language sql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
  select case when earth.current_role_kind() = 'human' then earth.current_human() else null end
$$;

-- `media_objects.content_type` → post media type, or null when the object is not post media.
create or replace function earth.media_type_of(p_content_type text)
returns text
language sql
immutable
strict
parallel safe
set search_path = public, earth, private, pg_temp
as $$
  select case
           when p_content_type like 'image/%' then 'image'
           when p_content_type like 'video/%' then 'video'
           when p_content_type like 'audio/%' then 'audio'
           else null
         end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Posts
-- ---------------------------------------------------------------------------------------------------

create or replace function public.post_create(
  type public.post_type default 'text',
  text text default null,
  audience public.audience default 'friends',
  area_id uuid default null,
  place_id uuid default null,
  media uuid[] default '{}'::uuid[],
  reply_policy public.reply_policy default 'everyone_eligible',
  reshare_policy public.reshare_policy default 'allowed_within_audience',
  parent_post_id uuid default null,
  provenance public.media_provenance[] default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_type public.post_type := coalesce(type, 'text');
  v_text text := nullif(btrim(coalesce(text, '')), '');
  v_audience public.audience := coalesce(audience, 'friends');
  v_area uuid := area_id;
  v_place uuid := place_id;
  v_media uuid[] := coalesce(media, '{}'::uuid[]);
  v_provenance public.media_provenance[] := provenance;
  v_reply_policy public.reply_policy := coalesce(reply_policy, 'everyone_eligible');
  v_reshare_policy public.reshare_policy := coalesce(reshare_policy, 'allowed_within_audience');
  v_parent_id uuid := parent_post_id;
  v_parent public.posts%rowtype;
  v_root public.posts%rowtype;
  v_ctx public.human_context%rowtype;
  v_media_count integer := coalesce(array_length(v_media, 1), 0);
  v_object public.media_objects%rowtype;
  v_media_type text;
  v_id uuid;
  v_i integer;
begin
  perform earth.rate_limit_for_caller('post_create', 20, 3600);

  -- Content (SCREEN 06: at least one of text or media).
  if v_text is null and v_media_count = 0 then
    perform earth.raise('invalid_input', 'a post needs text or media');
  end if;
  if v_text is not null and length(v_text) > 2000 then
    perform earth.raise('invalid_input', 'text is longer than 2000 characters');
  end if;
  if v_media_count > 10 then
    perform earth.raise('invalid_input', 'at most 10 media items');
  end if;
  if v_media_count <> (select count(distinct m) from unnest(v_media) as m) then
    perform earth.raise('invalid_input', 'duplicate media');
  end if;
  if v_type = 'text' and (v_text is null or v_media_count > 0) then
    perform earth.raise('invalid_input', 'a text post carries text and no media');
  end if;
  if v_type in ('image', 'video') and v_media_count = 0 then
    perform earth.raise('invalid_input', 'an image or video post needs media');
  end if;
  if v_provenance is not null and coalesce(array_length(v_provenance, 1), 0) <> v_media_count then
    perform earth.raise('invalid_input', 'provenance must match media');
  end if;

  if v_parent_id is not null then
    -- Replies (spec §31, §72; SCREEN 07): the parent must be visible, the thread open to the caller,
    -- and the audience can never exceed the root's.
    v_parent := earth.assert_post_visible(v_parent_id, v_me);
    if v_parent.status <> 'active' then
      perform earth.raise('post_not_found');
    end if;
    if earth.is_blocked_either(v_me, v_parent.author_human_id) then
      perform earth.raise('blocked');
    end if;
    if v_parent.root_post_id is null then
      v_root := v_parent;
    else
      select * into v_root from public.posts r where r.id = v_parent.root_post_id;
      if not found or v_root.status <> 'active' or not earth.can_view_post(v_root.id, v_me) then
        perform earth.raise('post_not_found');
      end if;
      if earth.is_blocked_either(v_me, v_root.author_human_id) then
        perform earth.raise('blocked');
      end if;
    end if;
    if not earth.post_reply_allowed(v_root, v_me) then
      perform earth.raise('reply_not_allowed');
    end if;
    v_audience := least(v_audience, v_root.audience);
    v_area := case when v_audience in ('neighborhood', 'city') then v_root.area_id else v_area end;
  else
    -- Root posts: audience flags and the area context (spec §74: area ids, never coordinates).
    if (v_audience = 'neighborhood' and not earth.flag('NEIGHBORHOOD_ENABLED'))
       or (v_audience = 'city' and not earth.flag('CITY_ENABLED'))
       or (v_audience = 'world' and not earth.flag('WORLD_ENABLED')) then
      perform earth.raise('feature_disabled');
    end if;
    if v_audience in ('neighborhood', 'city') and v_area is null then
      select * into v_ctx from public.human_context hc where hc.human_id = v_me;
      if v_audience = 'neighborhood' then
        v_area := v_ctx.current_area_id;
      else
        v_area := coalesce(
          v_ctx.current_city_id,
          earth.area_ancestor_of_type(v_ctx.current_area_id, 'city'),
          v_ctx.home_city_id
        );
      end if;
      if v_area is null then
        perform earth.raise('area_not_found', 'no area context for a ' || v_audience || ' post');
      end if;
    end if;
  end if;

  if v_area is not null and not exists (select 1 from public.areas a where a.id = v_area) then
    perform earth.raise('area_not_found');
  end if;
  if v_place is not null and not exists (
    select 1 from public.places pl
     where pl.id = v_place and (pl.visibility = 'public' or pl.created_by_human_id = v_me)
  ) then
    perform earth.raise('invalid_input', 'unknown place');
  end if;

  -- Media objects must be the author's own uploads in the `media` bucket (DB_API §1).
  for v_i in 1 .. v_media_count loop
    select * into v_object from public.media_objects m where m.id = v_media[v_i];
    if not found or v_object.owner_human_id is distinct from v_me or v_object.bucket <> 'media' then
      perform earth.raise('invalid_input', 'media must be your own upload in the media bucket');
    end if;
    if earth.media_type_of(v_object.content_type) is null then
      perform earth.raise('invalid_input', 'unsupported media type ' || v_object.content_type);
    end if;
  end loop;

  insert into public.posts (
    author_human_id, type, text, audience, area_id, place_id, reply_policy, reshare_policy,
    parent_post_id, root_post_id, created_at
  )
  values (
    v_me, v_type, v_text, v_audience, v_area, v_place, v_reply_policy, v_reshare_policy,
    v_parent_id, case when v_parent_id is null then null else v_root.id end, earth.utc_now()
  )
  returning id into v_id;

  for v_i in 1 .. v_media_count loop
    select * into v_object from public.media_objects m where m.id = v_media[v_i];
    v_media_type := earth.media_type_of(v_object.content_type);
    insert into public.post_media (post_id, media_object_id, media_type, storage_key, width, height, duration_ms, provenance, position)
    values (
      v_id, v_object.id, v_media_type, v_object.storage_key,
      coalesce(v_object.width, 0), coalesce(v_object.height, 0), v_object.duration_ms,
      coalesce(v_provenance[v_i], 'unknown'), v_i - 1
    );
  end loop;

  return earth.post_json(v_id, v_me);
end
$$;

-- `PostDetailDto`: the post as the caller sees it plus the first page of visible replies.
create or replace function public.post_get(post_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_viewer uuid := earth.viewer_human();
  v_post public.posts := earth.assert_post_visible(post_id, v_viewer);
begin
  return earth.post_json(v_post.id, v_viewer)
      || jsonb_build_object('replies', public.post_replies(v_post.id, null, 20) -> 'replies');
end
$$;

-- `PostRepliesPageDto`: direct replies to a visible post, oldest first, keyset by the last reply id.
create or replace function public.post_replies(post_id uuid, cursor text default null, "limit" integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_viewer uuid := earth.viewer_human();
  v_post public.posts := earth.assert_post_visible(post_id, v_viewer);
  v_limit integer := least(greatest(coalesce("limit", 20), 1), 100);
  v_after_created timestamptz;
  v_after_id uuid;
  v_ids uuid[];
  v_page uuid[];
  v_rows jsonb;
begin
  if cursor is not null then
    begin
      v_after_id := cursor::uuid;
    exception
      when invalid_text_representation then
        perform earth.raise('invalid_input', 'cursor is not a reply id');
    end;
    select r.created_at into v_after_created
      from public.posts r
     where r.id = v_after_id and r.parent_post_id = v_post.id;
    if v_after_created is null then
      perform earth.raise('invalid_input', 'cursor is not a reply of this post');
    end if;
  end if;

  -- One row more than the page tells whether a next page exists.
  select coalesce(array_agg(r.id order by r.created_at, r.id), '{}'::uuid[])
    into v_ids
    from (
      select r.id, r.created_at
        from public.posts r
       where r.parent_post_id = v_post.id
         and r.status = 'active'
         and (v_after_id is null or (r.created_at, r.id) > (v_after_created, v_after_id))
         and earth.can_view_post(r.id, v_viewer)
       order by r.created_at, r.id
       limit v_limit + 1
    ) r;
  v_page := v_ids[1:v_limit];

  select coalesce(jsonb_agg(earth.post_json(ids.id, v_viewer) order by ids.ordinality), '[]'::jsonb)
    into v_rows
    from unnest(v_page) with ordinality as ids(id, ordinality);

  return jsonb_build_object(
    'replies', v_rows,
    'nextCursor', case when coalesce(array_length(v_ids, 1), 0) > v_limit then v_page[v_limit]::text else null end
  );
end
$$;

-- Soft delete by the author (or the service for moderation): content leaves distribution at once.
create or replace function public.post_delete(post_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_me uuid;
  v_post public.posts%rowtype;
begin
  if v_kind <> 'service' then
    v_me := earth.assert_human();
    perform earth.rate_limit_for_caller('post_delete', 60, 3600);
  end if;
  if post_id is null then
    perform earth.raise('invalid_input', 'post_id is required');
  end if;
  select * into v_post from public.posts p where p.id = post_delete.post_id for update;
  if not found or (v_kind <> 'service' and not earth.can_view_post(v_post.id, v_me)) then
    perform earth.raise('post_not_found');
  end if;
  if v_kind <> 'service' and v_post.author_human_id <> v_me then
    perform earth.raise('forbidden');
  end if;
  if v_post.status = 'active' then
    update public.posts p
       set status = 'removed', deleted_at = earth.utc_now(), text = null
     where p.id = v_post.id;
    perform earth.audit('post.delete', 'post', v_post.id, jsonb_build_object('authorHumanId', v_post.author_human_id));
  end if;
  return earth.post_json(v_post.id, v_me);
end
$$;

-- One reaction per Human per post: upsert, or remove when `reaction_type` is null. No notification in V1.
create or replace function public.post_reaction_set(post_id uuid, reaction_type text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_post public.posts := earth.assert_post_visible(post_id, v_me);
  v_reaction text := nullif(btrim(coalesce(reaction_type, '')), '');
  v_count integer;
begin
  perform earth.rate_limit_for_caller('post_reaction_set', 120, 60);
  if v_post.status <> 'active' then
    perform earth.raise('post_not_found');
  end if;
  if v_reaction is null then
    delete from public.post_reactions pr where pr.post_id = v_post.id and pr.human_id = v_me;
  else
    if length(v_reaction) > 16 then
      perform earth.raise('invalid_input', 'reaction_type is longer than 16 characters');
    end if;
    insert into public.post_reactions (post_id, human_id, reaction_type)
    values (v_post.id, v_me, v_reaction)
    on conflict on constraint post_reactions_pkey do update
      set reaction_type = excluded.reaction_type;
  end if;
  select p.reaction_count into v_count from public.posts p where p.id = v_post.id;
  return jsonb_build_object('postId', v_post.id, 'myReaction', v_reaction, 'reactionCount', v_count);
end
$$;

-- Hides a post from the caller's feeds (never from a direct fetch). Idempotent.
create or replace function public.post_hide(post_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_me uuid := earth.assert_human();
  v_post public.posts := earth.assert_post_visible(post_id, v_me);
begin
  perform earth.rate_limit_for_caller('post_hide', 120, 60);
  insert into public.post_hides (human_id, post_id)
  values (v_me, v_post.id)
  on conflict on constraint post_hides_pkey do nothing;
  return jsonb_build_object('postId', v_post.id, 'hidden', true);
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Feed candidates (spec §63–§69; ARCHITECTURE §9 step 1)
-- ---------------------------------------------------------------------------------------------------

-- The candidate pool for a scope, already permission-filtered, as `FeedCandidate` rows plus their
-- rendering payloads (`post`: PostViewDto; `live`: the live_candidates item). Root posts only,
-- created at or before `snapshot_at` (later pages of one scroll pin the same set), newest first up
-- to `limit` (default 200). Lives are the rooms tier's `live_candidates` for the same scope.
--   friends      own posts, direct friends' posts, followed Humans' posts the caller may see (never
--                the public posts of mere shared-group members, spec §64); Lives with friends,
--                group Lives.
--   neighborhood posts tagged inside the browsed neighborhood (`area_id` or the caller's current
--                area) whose audience reaches it; public Lives there.
--   city         posts tagged inside the browsed city; public Lives there.
--   world        world posts; public Lives. Visitors: world only while PUBLIC_WORLD_ENABLED.
-- Fixture Humans are excluded when app_settings.environment = 'production'.
create or replace function public.feed_candidates(
  scope public.audience,
  area_id uuid default null,
  snapshot_at timestamptz default null,
  "limit" integer default 200
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_scope public.audience := scope;
  v_area uuid := area_id;
  v_snapshot timestamptz := coalesce(snapshot_at, earth.utc_now());
  v_limit integer := least(greatest(coalesce("limit", 200), 1), 500);
  v_me uuid;
  v_ctx public.human_context%rowtype;
  v_production boolean := coalesce(earth.setting('environment'), '') = 'production';
  v_posts jsonb := '[]'::jsonb;
  v_lives jsonb := '[]'::jsonb;
  v_live_items jsonb;
begin
  if v_scope is null then
    perform earth.raise('invalid_input', 'scope is required');
  end if;
  if v_kind = 'human' then
    v_me := earth.current_human();
  end if;
  if v_me is null then
    if v_scope <> 'world' then
      perform earth.raise('not_authenticated');
    end if;
    if not earth.flag('PUBLIC_WORLD_ENABLED') then
      perform earth.raise('feature_disabled');
    end if;
  end if;
  if (v_scope = 'neighborhood' and not earth.flag('NEIGHBORHOOD_ENABLED'))
     or (v_scope = 'city' and not earth.flag('CITY_ENABLED'))
     or (v_scope = 'world' and v_me is not null and not earth.flag('WORLD_ENABLED')) then
    perform earth.raise('feature_disabled');
  end if;

  if v_me is not null then
    select * into v_ctx from public.human_context hc where hc.human_id = v_me;
  end if;
  if v_scope = 'neighborhood' then
    v_area := coalesce(v_area, v_ctx.current_area_id);
  elsif v_scope = 'city' then
    v_area := coalesce(v_area, v_ctx.current_city_id, earth.area_ancestor_of_type(v_ctx.current_area_id, 'city'), v_ctx.home_city_id);
  else
    v_area := null;
  end if;
  if v_scope in ('neighborhood', 'city') then
    if v_area is null or not exists (select 1 from public.areas a where a.id = v_area) then
      perform earth.raise('area_not_found');
    end if;
  end if;

  -- Posts.
  with pool as (
    select p.id, p.author_human_id, p.created_at
      from public.posts p
      join public.humans h on h.id = p.author_human_id
     where p.status = 'active'
       and p.parent_post_id is null
       and p.created_at <= v_snapshot
       and h.status = 'active'
       and not (v_production and h.is_fixture)
       and case v_scope
             when 'friends' then
               v_me is not null and (
                 p.author_human_id = v_me
                 or earth.are_friends(v_me, p.author_human_id)
                 or earth.is_following(v_me, p.author_human_id)
               )
             when 'neighborhood' then
               p.area_id is not null and p.audience in ('neighborhood', 'city', 'world')
               and earth.area_contains(v_area, p.area_id)
             when 'city' then
               p.area_id is not null and p.audience in ('neighborhood', 'city', 'world')
               and earth.area_contains(v_area, p.area_id)
             else p.audience = 'world'
           end
       and earth.can_view_post(p.id, v_me)
       and not earth.post_hidden_by(p.id, v_me)
     order by p.created_at desc, p.id
     limit v_limit
  ),
  counted as (
    select pool.id, pool.created_at, count(*) over (partition by pool.author_human_id)::integer as author_recent
      from pool
  )
  select coalesce(jsonb_agg(earth.post_candidate_json(c.id, v_me, c.author_recent) order by c.created_at desc, c.id), '[]'::jsonb)
    into v_posts
    from counted c;

  -- Lives: the rooms tier decides discoverability (DB_API §3). Visitors need PUBLIC_LIVE_ENABLED;
  -- Guests have no discovery surface.
  if v_kind = 'human' and v_me is not null
     or (v_kind in ('visitor', 'claiming', 'service') and v_scope = 'world' and earth.flag('PUBLIC_LIVE_ENABLED')) then
    v_live_items := public.live_candidates(v_scope, v_area, 100) -> 'candidates';
    select coalesce(jsonb_agg(earth.live_candidate_json(item, v_me) order by item ->> 'startedAt' desc, item ->> 'roomId'), '[]'::jsonb)
      into v_lives
      from jsonb_array_elements(coalesce(v_live_items, '[]'::jsonb)) as item
      join public.rooms r on r.id = (item ->> 'roomId')::uuid
      join public.humans h on h.id = r.initiated_by_human_id
     where not (v_production and h.is_fixture);
  end if;

  return jsonb_build_object(
    'candidates', v_lives || v_posts,
    'scope', v_scope,
    'areaId', v_area,
    'areaName', earth.area_name(v_area),
    'snapshotAt', to_jsonb(v_snapshot)
  );
end
$$;

-- Visitor convenience for SSR (SCREEN 01): world post candidates newest first, keyset on
-- `created_at` (`cursor` = the last row's createdAt). Same rows as feed_candidates('world');
-- ranking still happens in the server tier. Humans get their own permission view of the same pool.
create or replace function public.public_feed(cursor timestamptz default null, "limit" integer default 20)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_me uuid;
  v_limit integer := least(greatest(coalesce("limit", 20), 1), 100);
  v_snapshot timestamptz := earth.utc_now();
  v_production boolean := coalesce(earth.setting('environment'), '') = 'production';
  v_rows jsonb;
  v_next timestamptz;
  v_count integer;
begin
  if v_kind = 'human' then
    v_me := earth.current_human();
  end if;
  if v_me is null and not earth.flag('PUBLIC_WORLD_ENABLED') then
    perform earth.raise('feature_disabled');
  end if;
  if v_me is not null and not earth.flag('WORLD_ENABLED') then
    perform earth.raise('feature_disabled');
  end if;

  with pool as (
    select p.id, p.author_human_id, p.created_at
      from public.posts p
      join public.humans h on h.id = p.author_human_id
     where p.status = 'active'
       and p.parent_post_id is null
       and p.audience = 'world'
       and p.created_at <= v_snapshot
       and (cursor is null or p.created_at < cursor)
       and h.status = 'active'
       and not (v_production and h.is_fixture)
       and earth.can_view_post(p.id, v_me)
       and not earth.post_hidden_by(p.id, v_me)
     order by p.created_at desc, p.id
     limit v_limit + 1
  ),
  page as (
    select pool.id, pool.created_at, count(*) over (partition by pool.author_human_id)::integer as author_recent
      from pool
     order by pool.created_at desc, pool.id
     limit v_limit
  )
  select coalesce(jsonb_agg(earth.post_candidate_json(page.id, v_me, page.author_recent) order by page.created_at desc, page.id), '[]'::jsonb),
         min(page.created_at)
    into v_rows, v_next
    from page;

  select count(*) into v_count
    from public.posts p
    join public.humans h on h.id = p.author_human_id
   where p.status = 'active'
     and p.parent_post_id is null
     and p.audience = 'world'
     and p.created_at <= v_snapshot
     and (cursor is null or p.created_at < cursor)
     and p.created_at < coalesce(v_next, 'infinity'::timestamptz)
     and h.status = 'active'
     and not (v_production and h.is_fixture)
     and earth.can_view_post(p.id, v_me)
     and not earth.post_hidden_by(p.id, v_me);

  return jsonb_build_object(
    'candidates', v_rows,
    'nextCursor', case when v_count > 0 then to_jsonb(v_next) else null end,
    'snapshotAt', to_jsonb(v_snapshot),
    'scope', 'world',
    'areaId', null,
    'areaName', null
  );
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------

revoke execute on function public.post_create(public.post_type, text, public.audience, uuid, uuid, uuid[], public.reply_policy, public.reshare_policy, uuid, public.media_provenance[]) from public;
revoke execute on function public.post_get(uuid) from public;
revoke execute on function public.post_replies(uuid, text, integer) from public;
revoke execute on function public.post_delete(uuid) from public;
revoke execute on function public.post_reaction_set(uuid, text) from public;
revoke execute on function public.post_hide(uuid) from public;
revoke execute on function public.feed_candidates(public.audience, uuid, timestamptz, integer) from public;
revoke execute on function public.public_feed(timestamptz, integer) from public;

grant execute on function public.post_create(public.post_type, text, public.audience, uuid, uuid, uuid[], public.reply_policy, public.reshare_policy, uuid, public.media_provenance[]) to anon, authenticated, service_role;
grant execute on function public.post_get(uuid) to anon, authenticated, service_role;
grant execute on function public.post_replies(uuid, text, integer) to anon, authenticated, service_role;
grant execute on function public.post_delete(uuid) to anon, authenticated, service_role;
grant execute on function public.post_reaction_set(uuid, text) to anon, authenticated, service_role;
grant execute on function public.post_hide(uuid) to anon, authenticated, service_role;
grant execute on function public.feed_candidates(public.audience, uuid, timestamptz, integer) to anon, authenticated, service_role;
grant execute on function public.public_feed(timestamptz, integer) to anon, authenticated, service_role;

-- Internals that raise or reveal state stay owner/service only; the policy helpers keep the
-- schema-default EXECUTE so RLS (0420) can evaluate them as any caller.
revoke execute on function earth.assert_post_visible(uuid, uuid) from public, anon, authenticated;
