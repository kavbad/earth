-- 0150 — groups, membership, invites and conversation membership (spec §22–26; DB_API §2).
--
-- A group exists even without a name and always has exactly one canonical conversation
-- (`conversations.group_id` unique). Direct conversations are keyed by the sorted pair of Human ids
-- (`direct_key`) so `conversation_direct_get_or_create` is idempotent. `groups.member_count` and
-- `conversation_members.unread_count` are maintained by triggers (the unread trigger on messages
-- comes with messaging). `active_room_id` columns are bare uuids until rooms land (03xx).
-- Invite tokens are stored hashed only (ARCHITECTURE §5); clients read invites through
-- `group_invites_view` (0170), never the table. Policies and grants live in 0170.

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  created_by_human_id uuid not null references public.humans (id) on delete restrict,
  name text,
  avatar_media_id uuid references public.media_objects (id) on delete set null,
  kind public.group_kind not null default 'persistent',
  status text not null default 'active',
  active_room_id uuid,
  member_count integer not null default 0,
  created_at timestamptz not null default now(),
  last_activity_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint groups_name_check check (name is null or length(btrim(name)) between 1 and 60),
  constraint groups_status_check check (status in ('active', 'archived', 'deleted')),
  constraint groups_member_count_check check (member_count >= 0)
);

create index groups_created_by_human_id_idx on public.groups (created_by_human_id);
create index groups_avatar_media_id_idx on public.groups (avatar_media_id);
create index groups_active_room_id_idx on public.groups (active_room_id);
create index groups_status_idx on public.groups (status);

create trigger groups_touch_updated_at
  before update on public.groups
  for each row execute function earth.touch_updated_at();

create table public.group_members (
  group_id uuid not null references public.groups (id) on delete cascade,
  human_id uuid not null references public.humans (id) on delete cascade,
  role public.group_member_role not null default 'member',
  status public.group_member_status not null default 'active',
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  removed_by_human_id uuid references public.humans (id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint group_members_pkey primary key (group_id, human_id),
  constraint group_members_left_at_check check ((status = 'active') = (left_at is null))
);

create index group_members_human_status_idx on public.group_members (human_id, status);
create index group_members_group_status_role_idx on public.group_members (group_id, status, role, joined_at);
create index group_members_removed_by_human_id_idx on public.group_members (removed_by_human_id);

create trigger group_members_touch_updated_at
  before update on public.group_members
  for each row execute function earth.touch_updated_at();

-- groups.member_count = active memberships.
create or replace function earth.group_members_count_trigger()
returns trigger
language plpgsql
set search_path = public, earth, private, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'active' then
      update public.groups set member_count = member_count + 1 where id = new.group_id;
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if old.status = 'active' and new.status <> 'active' then
      update public.groups set member_count = greatest(member_count - 1, 0) where id = new.group_id;
    elsif old.status <> 'active' and new.status = 'active' then
      update public.groups set member_count = member_count + 1 where id = new.group_id;
    end if;
    return new;
  elsif tg_op = 'DELETE' then
    if old.status = 'active' then
      update public.groups set member_count = greatest(member_count - 1, 0) where id = old.group_id;
    end if;
    return old;
  end if;
  return null;
end
$$;

create trigger group_members_count
  after insert or update of status or delete on public.group_members
  for each row execute function earth.group_members_count_trigger();

create table public.group_invites (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  created_by uuid not null references public.humans (id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz,
  max_uses integer,
  use_count integer not null default 0,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint group_invites_token_hash_key unique (token_hash),
  constraint group_invites_token_hash_check check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint group_invites_max_uses_check check (max_uses is null or max_uses > 0),
  constraint group_invites_use_count_check check (use_count >= 0),
  constraint group_invites_status_check check (status in ('active', 'revoked', 'expired', 'exhausted'))
);

create index group_invites_group_id_idx on public.group_invites (group_id);
create index group_invites_created_by_idx on public.group_invites (created_by);

create trigger group_invites_touch_updated_at
  before update on public.group_invites
  for each row execute function earth.touch_updated_at();

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  type public.conversation_type not null,
  group_id uuid references public.groups (id) on delete cascade,
  active_room_id uuid,
  direct_key text,
  created_at timestamptz not null default now(),
  last_message_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint conversations_shape_check check (
    (type = 'direct' and group_id is null and direct_key is not null)
    or (type = 'group' and group_id is not null and direct_key is null)
  ),
  constraint conversations_direct_key_check check (
    direct_key is null or direct_key ~ '^[0-9a-f-]{36}:[0-9a-f-]{36}$'
  ),
  constraint conversations_direct_key_key unique (direct_key)
);

-- One canonical primary conversation per group (spec §25).
create unique index conversations_group_id_key on public.conversations (group_id) where group_id is not null;
create index conversations_active_room_id_idx on public.conversations (active_room_id);
create index conversations_last_message_at_idx on public.conversations (coalesce(last_message_at, created_at) desc);

create trigger conversations_touch_updated_at
  before update on public.conversations
  for each row execute function earth.touch_updated_at();

create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  human_id uuid not null references public.humans (id) on delete cascade,
  joined_at timestamptz not null default now(),
  last_read_message_id uuid,
  last_read_at timestamptz,
  unread_count integer not null default 0,
  mute_state text not null default 'none',
  notification_level text not null default 'all',
  updated_at timestamptz not null default now(),
  constraint conversation_members_pkey primary key (conversation_id, human_id),
  constraint conversation_members_unread_count_check check (unread_count >= 0),
  constraint conversation_members_mute_state_check check (mute_state in ('none', 'muted')),
  constraint conversation_members_notification_level_check check (notification_level in ('all', 'mentions', 'none'))
);

create index conversation_members_human_id_idx on public.conversation_members (human_id);
create index conversation_members_last_read_message_id_idx on public.conversation_members (last_read_message_id);

create trigger conversation_members_touch_updated_at
  before update on public.conversation_members
  for each row execute function earth.touch_updated_at();

alter table public.human_presence
  add constraint human_presence_active_conversation_id_fkey
  foreign key (active_conversation_id) references public.conversations (id) on delete set null;

alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.group_invites enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
