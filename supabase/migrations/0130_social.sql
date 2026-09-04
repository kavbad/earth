-- 0130 — social graph (spec §20–21, §128; DB_API §1).
--
-- `friend` is stored as two rows (one per direction, written in one transaction), `friend_pending`
-- as one row from requester to target, `follow` and `familiar_private` directional. Blocks override
-- every surface: the helpers below are what policies and RPCs call. Writes go through RPCs (0180).
-- Helpers that look at group membership are plpgsql so they can be created before 0150.

create table public.relationships (
  id uuid primary key default gen_random_uuid(),
  source_human_id uuid not null references public.humans (id) on delete cascade,
  target_human_id uuid not null references public.humans (id) on delete cascade,
  type public.relationship_type not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint relationships_not_self check (source_human_id <> target_human_id),
  constraint relationships_source_target_type_key unique (source_human_id, target_human_id, type)
);

create index relationships_target_type_idx on public.relationships (target_human_id, type);
create index relationships_source_type_idx on public.relationships (source_human_id, type);

create trigger relationships_touch_updated_at
  before update on public.relationships
  for each row execute function earth.touch_updated_at();

create table public.blocks (
  blocker_human_id uuid not null references public.humans (id) on delete cascade,
  blocked_human_id uuid not null references public.humans (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint blocks_pkey primary key (blocker_human_id, blocked_human_id),
  constraint blocks_not_self check (blocker_human_id <> blocked_human_id)
);

create index blocks_blocked_human_id_idx on public.blocks (blocked_human_id);

alter table public.relationships enable row level security;
alter table public.blocks enable row level security;

-- True when `blocker` has blocked `blocked`.
create or replace function earth.has_blocked(blocker uuid, blocked uuid)
returns boolean
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select blocker is not null and blocked is not null and exists (
    select 1 from public.blocks b
     where b.blocker_human_id = blocker and b.blocked_human_id = blocked
  )
$$;

-- True when a block exists in either direction. Null ids never count as blocked.
create or replace function earth.is_blocked_either(a uuid, b uuid)
returns boolean
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select a is not null and b is not null and exists (
    select 1 from public.blocks x
     where (x.blocker_human_id = a and x.blocked_human_id = b)
        or (x.blocker_human_id = b and x.blocked_human_id = a)
  )
$$;

-- Friendship is canonical in both directions; either row is enough to answer.
create or replace function earth.are_friends(a uuid, b uuid)
returns boolean
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select a is not null and b is not null and a <> b and exists (
    select 1 from public.relationships r
     where r.type = 'friend'
       and ((r.source_human_id = a and r.target_human_id = b)
         or (r.source_human_id = b and r.target_human_id = a))
  )
$$;

-- `a` follows `b` (directional; never implies friendship).
create or replace function earth.is_following(a uuid, b uuid)
returns boolean
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select a is not null and b is not null and exists (
    select 1 from public.relationships r
     where r.type = 'follow' and r.source_human_id = a and r.target_human_id = b
  )
$$;

-- `a` marked `b` as familiar (hidden from `b`).
create or replace function earth.is_familiar(a uuid, b uuid)
returns boolean
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select a is not null and b is not null and exists (
    select 1 from public.relationships r
     where r.type = 'familiar_private' and r.source_human_id = a and r.target_human_id = b
  )
$$;

-- Groups both Humans are active members of (group_members is created in 0150).
create or replace function earth.shared_group_count(a uuid, b uuid)
returns integer
language plpgsql
stable
set search_path = public, earth, private, pg_temp
as $$
declare
  v_count integer;
begin
  if a is null or b is null or a = b then
    return 0;
  end if;
  select count(*) into v_count
    from public.group_members ga
    join public.group_members gb on gb.group_id = ga.group_id
    join public.groups g on g.id = ga.group_id
   where ga.human_id = a and ga.status = 'active'
     and gb.human_id = b and gb.status = 'active'
     and g.status = 'active';
  return v_count;
end
$$;

-- Friends the two Humans have in common.
create or replace function earth.mutual_friend_count(a uuid, b uuid)
returns integer
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select count(*)::integer
    from public.relationships ra
    join public.relationships rb on rb.target_human_id = ra.target_human_id
   where ra.type = 'friend' and ra.source_human_id = a
     and rb.type = 'friend' and rb.source_human_id = b
     and a is not null and b is not null and a <> b
$$;

-- Viewer relation (spec §60 ordering): self > friend > shared_group > familiar > other.
create or replace function earth.relation_to(viewer uuid, other uuid)
returns text
language plpgsql
stable
set search_path = public, earth, private, pg_temp
as $$
begin
  if viewer is null or other is null then
    return 'other';
  end if;
  if viewer = other then
    return 'self';
  end if;
  if earth.are_friends(viewer, other) then
    return 'friend';
  end if;
  if earth.shared_group_count(viewer, other) > 0 then
    return 'shared_group';
  end if;
  if earth.is_familiar(viewer, other) then
    return 'familiar';
  end if;
  return 'other';
end
$$;
