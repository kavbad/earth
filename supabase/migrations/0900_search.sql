-- 0900 — universal search (SCREEN 21; spec §21, §43, §83, §128 "Blocks override all discovery";
-- DB_API §9; ARCHITECTURE §4, §5).
--
-- `search(q, limit)` returns `SearchResultsDto` with four sections, each at most `limit` rows:
--   * people — active Humans with a visible identity (`earth.identity_visible_to`: blocks either
--              way, `limited` for signed-in Humans only, fixtures hidden from anonymous viewers in
--              production), never `hidden` profiles, never pending Humans, never the caller. Ranked
--              per SCREEN 21: exact handle / name, friend, mutual friend count, group overlap, same
--              city (the target's public home city only — nothing inferred), then relevance
--              (prefix, trigram similarity).
--   * groups — active groups the caller is a member of, by name; a group whose owner is blocked
--              either way is not listed (packages/domain/src/social/rules.ts BLOCK_OVERRIDE_RULES).
--   * places — public Places (and the caller's own private ones) by name.
--   * posts  — posts whose text matches, visible to the caller (`earth.can_view_post`), not hidden.
-- Visitors, Guests and claiming Humans read as anonymous viewers: people (public profiles) and
-- places only. Rate limited 60 per minute (spec §83; anonymous callers get the reduced budget).
-- Trigram indexes back the substring matches; `extensions.similarity() >= 0.3` catches typos.

-- ---------------------------------------------------------------------------------------------------
-- Indexes (pg_trgm lives in `extensions`, 0001). `places(name)` already has one (0050).
-- ---------------------------------------------------------------------------------------------------

create index public_identities_display_name_trgm_idx
  on public.public_identities using gin (display_name extensions.gin_trgm_ops);
create index public_identities_handle_trgm_idx
  on public.public_identities using gin (handle extensions.gin_trgm_ops);
create index groups_name_trgm_idx
  on public.groups using gin (name extensions.gin_trgm_ops)
  where name is not null;
create index posts_text_trgm_idx
  on public.posts using gin (text extensions.gin_trgm_ops)
  where status = 'active' and text is not null;

-- ---------------------------------------------------------------------------------------------------
-- search
-- ---------------------------------------------------------------------------------------------------

create or replace function public.search(q text, "limit" integer default 10)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_q text := earth.search_query(q);
  v_limit integer := least(greatest(coalesce("limit", 10), 1), 50);
  v_me uuid;
  v_production boolean := coalesce(earth.setting('environment'), '') = 'production';
  v_pattern text;
  v_prefix text;
  v_handle_q text;
  v_handle_pattern text;
  v_handle_prefix text;
  v_my_city uuid;
  v_people jsonb := '[]'::jsonb;
  v_groups jsonb := '[]'::jsonb;
  v_places jsonb := '[]'::jsonb;
  v_posts jsonb := '[]'::jsonb;
begin
  if v_kind = 'human' then
    v_me := earth.current_human();
  end if;
  perform earth.rate_limit_for_caller('search', 60, 60);

  v_pattern := '%' || earth.like_escape(v_q) || '%';
  v_prefix := earth.like_escape(v_q) || '%';
  -- `@maya` finds the handle `maya`; handles are stored lowercase.
  v_handle_q := lower(coalesce(nullif(btrim(ltrim(v_q, '@')), ''), v_q));
  v_handle_pattern := '%' || earth.like_escape(v_handle_q) || '%';
  v_handle_prefix := earth.like_escape(v_handle_q) || '%';

  -- The caller's city for "same city": their public identity's home city, else their context.
  if v_me is not null then
    select coalesce(pi.home_city_area_id, hc.current_city_id, hc.home_city_id)
      into v_my_city
      from public.humans h
      left join public.public_identities pi on pi.human_id = h.id
      left join public.human_context hc on hc.human_id = h.id
     where h.id = v_me;
  end if;

  -- People ----------------------------------------------------------------------------------------
  with matched as (
    select p.human_id, p.display_name, p.handle, p.avatar_media_id,
           (lower(p.handle) = v_handle_q or lower(p.display_name) = lower(v_q)) as exact,
           (v_me is not null and earth.are_friends(v_me, p.human_id)) as is_friend,
           case when v_me is null then 0 else earth.mutual_friend_count(v_me, p.human_id) end as mutual,
           case when v_me is null then 0 else earth.shared_group_count(v_me, p.human_id) end as shared,
           (v_my_city is not null and p.public_city_visibility and p.home_city_area_id = v_my_city) as same_city,
           (p.handle ilike v_handle_prefix escape '\' or p.display_name ilike v_prefix escape '\') as prefix,
           greatest(extensions.similarity(p.display_name, v_q), extensions.similarity(p.handle, v_handle_q)) as sim
      from public.public_identities p
      join public.humans h on h.id = p.human_id
     where h.status = 'active'
       and p.profile_visibility <> 'hidden'
       and (v_me is null or p.human_id <> v_me)
       and (p.display_name ilike v_pattern escape '\'
            or p.handle ilike v_handle_pattern escape '\'
            or extensions.similarity(p.display_name, v_q) >= 0.3
            or extensions.similarity(p.handle, v_handle_q) >= 0.3)
       and earth.identity_visible_to(p.human_id, v_me)
  ),
  ranked as (
    select *
      from matched m
     order by m.exact desc, m.is_friend desc, m.mutual desc, m.shared desc, m.same_city desc,
              m.prefix desc, m.sim desc, m.display_name, m.human_id
     limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'humanId', r.human_id,
           'displayName', r.display_name,
           'handle', r.handle,
           'avatarUrl', earth.public_media_url(r.avatar_media_id),
           'mutualFriendCount', r.mutual,
           'cityName', earth.identity_city_name(r.human_id),
           'isFriend', r.is_friend,
           'isFollowing', earth.is_following(v_me, r.human_id)
         ) order by r.exact desc, r.is_friend desc, r.mutual desc, r.shared desc, r.same_city desc,
                    r.prefix desc, r.sim desc, r.display_name, r.human_id), '[]'::jsonb)
    into v_people
    from ranked r;

  -- Groups (members only) ---------------------------------------------------------------------------
  if v_me is not null then
    with matched as (
      select g.id, g.name, g.avatar_media_id, g.member_count,
             lower(g.name) = lower(v_q) as exact,
             g.name ilike v_prefix escape '\' as prefix,
             extensions.similarity(g.name, v_q) as sim
        from public.groups g
       where g.status = 'active'
         and g.name is not null
         and (g.name ilike v_pattern escape '\' or extensions.similarity(g.name, v_q) >= 0.3)
         and earth.is_group_member(g.id, v_me)
         and not exists (
           select 1
             from public.group_members gm
            where gm.group_id = g.id
              and gm.status = 'active'
              and gm.role = 'owner'
              and earth.is_blocked_either(gm.human_id, v_me)
         )
    ),
    ranked as (
      select *
        from matched m
       order by m.exact desc, m.prefix desc, m.sim desc, m.name, m.id
       limit v_limit
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'groupId', r.id,
             'name', r.name,
             'avatarUrl', earth.public_media_url(r.avatar_media_id),
             'memberCount', greatest(r.member_count, 0),
             'isMember', true
           ) order by r.exact desc, r.prefix desc, r.sim desc, r.name, r.id), '[]'::jsonb)
      into v_groups
      from ranked r;
  end if;

  -- Places ------------------------------------------------------------------------------------------
  with matched as (
    select pl.id, pl.name, pl.area_id, pl.lat, pl.lng, pl.category,
           lower(pl.name) = lower(v_q) as exact,
           pl.name ilike v_prefix escape '\' as prefix,
           extensions.similarity(pl.name, v_q) as sim
      from public.places pl
     where (pl.name ilike v_pattern escape '\' or extensions.similarity(pl.name, v_q) >= 0.3)
       and (pl.visibility = 'public' or (v_me is not null and pl.created_by_human_id = v_me))
       and not (v_production and pl.is_fixture)
  ),
  ranked as (
    select *
      from matched m
     order by m.exact desc, m.prefix desc, m.sim desc, m.name, m.id
     limit v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'placeId', r.id,
           'name', r.name,
           'areaName', earth.area_name(r.area_id),
           'lat', r.lat,
           'lng', r.lng,
           'category', r.category
         ) order by r.exact desc, r.prefix desc, r.sim desc, r.name, r.id), '[]'::jsonb)
    into v_places
    from ranked r;

  -- Posts (Humans only; visibility is earth.can_view_post) --------------------------------------------
  if v_me is not null then
    with matched as (
      select p.id, p.created_at,
             p.text ilike v_pattern escape '\' as contains,
             extensions.similarity(p.text, v_q) as sim
        from public.posts p
        join public.humans h on h.id = p.author_human_id
       where p.status = 'active'
         and p.text is not null
         and h.status = 'active'
         and not (v_production and h.is_fixture)
         and (p.text ilike v_pattern escape '\' or extensions.similarity(p.text, v_q) >= 0.3)
         and earth.can_view_post(p.id, v_me)
         and not earth.post_hidden_by(p.id, v_me)
    ),
    ranked as (
      select *
        from matched m
       order by m.contains desc, m.sim desc, m.created_at desc, m.id
       limit v_limit
    )
    select coalesce(jsonb_agg(earth.post_json(r.id, v_me)
             order by r.contains desc, r.sim desc, r.created_at desc, r.id), '[]'::jsonb)
      into v_posts
      from ranked r;
  end if;

  return jsonb_build_object(
    'people', v_people,
    'groups', v_groups,
    'places', v_places,
    'posts', v_posts
  );
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------

revoke execute on function public.search(text, integer) from public;
grant execute on function public.search(text, integer) to anon, authenticated, service_role;
