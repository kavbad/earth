-- 0400 — posts, post media, reactions and hides (spec §29–§31, §72; DB_API §4 tables).
--
-- A post's `audience` is who the author intended to reach (spec §29) and is never widened: replies
-- carry `parent_post_id` / `root_post_id` and are stored with an audience no wider than the root's
-- (post_create, 0430). Deletion is soft: `post_delete` sets `status = 'removed'`, `deleted_at` and
-- clears the text and media so the content leaves distribution at once (spec §72) while the row keeps
-- the thread shape. `reply_count` (active direct replies) and `reaction_count` are maintained by
-- triggers. `status` is text with a check (no domain enum exists for it; DB_API §4 names the values).
-- Policies and grants live in 0420; nothing here is reachable by anon/authenticated until then.

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  author_human_id uuid not null references public.humans (id) on delete cascade,
  type public.post_type not null default 'text',
  text text,
  audience public.audience not null,
  area_id uuid references public.areas (id) on delete set null,
  place_id uuid references public.places (id) on delete set null,
  reply_policy public.reply_policy not null default 'everyone_eligible',
  reshare_policy public.reshare_policy not null default 'allowed_within_audience',
  parent_post_id uuid references public.posts (id) on delete cascade,
  root_post_id uuid references public.posts (id) on delete cascade,
  -- Reserved for reshares (spec §72 "allowed reshare audience"); no V1 RPC writes it.
  reshare_of_post_id uuid references public.posts (id) on delete set null,
  reply_count integer not null default 0,
  reaction_count integer not null default 0,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint posts_text_length_check check (text is null or length(text) <= 2000),
  constraint posts_status_check check (status in ('active', 'removed')),
  constraint posts_reply_shape_check check ((parent_post_id is null) = (root_post_id is null)),
  constraint posts_not_self_reply_check check (parent_post_id is null or parent_post_id <> id),
  constraint posts_not_self_root_check check (root_post_id is null or root_post_id <> id),
  constraint posts_not_self_reshare_check check (reshare_of_post_id is null or reshare_of_post_id <> id),
  constraint posts_counts_check check (reply_count >= 0 and reaction_count >= 0),
  constraint posts_removed_check check ((status = 'removed') = (deleted_at is not null)),
  -- A text post needs text until it is removed (media posts are validated by post_create).
  constraint posts_text_required_check check (
    deleted_at is not null or type <> 'text' or length(btrim(coalesce(text, ''))) > 0
  ),
  -- A removed post keeps no content.
  constraint posts_tombstone_check check (deleted_at is null or text is null)
);

-- Author timeline / profile counts.
create index posts_author_created_idx on public.posts (author_human_id, created_at desc, id);
-- Audience pools (feed_candidates): root posts of an audience, newest first.
create index posts_audience_created_idx on public.posts (audience, created_at desc, id)
  where status = 'active' and parent_post_id is null;
-- Area pools (neighborhood / city scopes, map moments).
create index posts_area_created_idx on public.posts (area_id, created_at desc, id)
  where status = 'active' and area_id is not null;
create index posts_created_idx on public.posts (created_at desc, id) where status = 'active';
create index posts_parent_created_idx on public.posts (parent_post_id, created_at, id) where parent_post_id is not null;
create index posts_root_post_id_idx on public.posts (root_post_id) where root_post_id is not null;
create index posts_place_id_idx on public.posts (place_id) where place_id is not null;
create index posts_reshare_of_post_id_idx on public.posts (reshare_of_post_id) where reshare_of_post_id is not null;
create index posts_status_idx on public.posts (status);

create trigger posts_touch_updated_at
  before update on public.posts
  for each row execute function earth.touch_updated_at();

create table public.post_media (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts (id) on delete cascade,
  media_object_id uuid not null references public.media_objects (id) on delete restrict,
  media_type text not null,
  storage_key text not null,
  width integer not null default 0,
  height integer not null default 0,
  duration_ms integer,
  provenance public.media_provenance not null default 'unknown',
  position integer not null default 0,
  created_at timestamptz not null default now(),
  constraint post_media_media_type_check check (media_type in ('image', 'video', 'audio')),
  constraint post_media_storage_key_check check (length(storage_key) between 1 and 512),
  constraint post_media_dimensions_check check (width >= 0 and height >= 0 and (duration_ms is null or duration_ms >= 0)),
  constraint post_media_position_check check (position >= 0),
  constraint post_media_post_object_key unique (post_id, media_object_id)
);

create index post_media_post_position_idx on public.post_media (post_id, position, id);
create index post_media_media_object_id_idx on public.post_media (media_object_id);

create table public.post_reactions (
  post_id uuid not null references public.posts (id) on delete cascade,
  human_id uuid not null references public.humans (id) on delete cascade,
  reaction_type text not null,
  created_at timestamptz not null default now(),
  constraint post_reactions_pkey primary key (post_id, human_id),
  constraint post_reactions_reaction_type_check check (
    length(reaction_type) between 1 and 16 and reaction_type = btrim(reaction_type)
  )
);

create index post_reactions_human_id_idx on public.post_reactions (human_id, created_at desc);

create table public.post_hides (
  human_id uuid not null references public.humans (id) on delete cascade,
  post_id uuid not null references public.posts (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint post_hides_pkey primary key (human_id, post_id)
);

create index post_hides_post_id_idx on public.post_hides (post_id);

-- ---------------------------------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------------------------------

-- Thread identity never changes; a removed post keeps no content and stays removed.
create or replace function earth.posts_before_update_trigger()
returns trigger
language plpgsql
set search_path = public, earth, private, pg_temp
as $$
begin
  if new.id <> old.id
     or new.author_human_id <> old.author_human_id
     or new.parent_post_id is distinct from old.parent_post_id
     or new.root_post_id is distinct from old.root_post_id
     or new.created_at <> old.created_at then
    perform earth.raise('invalid_input', 'post identity columns are immutable');
  end if;
  if old.status = 'removed' and new.status <> 'removed' then
    perform earth.raise('invalid_input', 'a removed post cannot be restored');
  end if;
  if new.status = 'removed' then
    new.text := null;
  end if;
  return new;
end
$$;

create trigger posts_before_update
  before update on public.posts
  for each row execute function earth.posts_before_update_trigger();

-- posts.reply_count = active direct replies.
create or replace function earth.posts_reply_count_trigger()
returns trigger
language plpgsql
set search_path = public, earth, private, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.parent_post_id is not null and new.status = 'active' then
      update public.posts set reply_count = reply_count + 1 where id = new.parent_post_id;
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if new.parent_post_id is not null then
      if old.status = 'active' and new.status <> 'active' then
        update public.posts set reply_count = greatest(reply_count - 1, 0) where id = new.parent_post_id;
      elsif old.status <> 'active' and new.status = 'active' then
        update public.posts set reply_count = reply_count + 1 where id = new.parent_post_id;
      end if;
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if old.parent_post_id is not null and old.status = 'active' then
      update public.posts set reply_count = greatest(reply_count - 1, 0) where id = old.parent_post_id;
    end if;
    return old;
  end if;
  return null;
end
$$;

create trigger posts_reply_count
  after insert or update of status or delete on public.posts
  for each row execute function earth.posts_reply_count_trigger();

-- Media rows of a removed post go away with the content.
create or replace function earth.posts_after_remove_trigger()
returns trigger
language plpgsql
set search_path = public, earth, private, pg_temp
as $$
begin
  if old.status <> 'removed' and new.status = 'removed' then
    delete from public.post_media pm where pm.post_id = new.id;
  end if;
  return new;
end
$$;

create trigger posts_after_remove
  after update of status on public.posts
  for each row execute function earth.posts_after_remove_trigger();

-- posts.reaction_count = rows in post_reactions.
create or replace function earth.post_reactions_count_trigger()
returns trigger
language plpgsql
set search_path = public, earth, private, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set reaction_count = reaction_count + 1 where id = new.post_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.posts set reaction_count = greatest(reaction_count - 1, 0) where id = old.post_id;
    return old;
  end if;
  return null;
end
$$;

create trigger post_reactions_count
  after insert or delete on public.post_reactions
  for each row execute function earth.post_reactions_count_trigger();

alter table public.posts enable row level security;
alter table public.post_media enable row level security;
alter table public.post_reactions enable row level security;
alter table public.post_hides enable row level security;
