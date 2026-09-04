-- 0140 — presence, area context and push tokens (DB_API §1; ARCHITECTURE §8, §11).
--
-- `human_context` stores scope selections and area ids only — never coordinates (spec §74).
-- `human_presence.active_conversation_id` gets its foreign key in 0150 (conversations comes later);
-- `active_room_id` is a bare uuid until rooms land (03xx). Own-row policies live in 0170.

create table public.human_presence (
  human_id uuid primary key references public.humans (id) on delete cascade,
  last_active_at timestamptz not null default now(),
  active_conversation_id uuid,
  active_room_id uuid,
  platform text,
  updated_at timestamptz not null default now(),
  constraint human_presence_platform_check check (platform is null or platform in ('ios', 'android', 'web'))
);

create index human_presence_active_conversation_id_idx on public.human_presence (active_conversation_id);
create index human_presence_active_room_id_idx on public.human_presence (active_room_id);
create index human_presence_last_active_at_idx on public.human_presence (last_active_at);

create trigger human_presence_touch_updated_at
  before update on public.human_presence
  for each row execute function earth.touch_updated_at();

create table public.human_context (
  human_id uuid primary key references public.humans (id) on delete cascade,
  current_area_id uuid references public.areas (id) on delete set null,
  current_city_id uuid references public.areas (id) on delete set null,
  home_city_id uuid references public.areas (id) on delete set null,
  last_scope_home public.audience not null default 'friends',
  last_scope_live public.audience not null default 'friends',
  last_scope_earth public.audience not null default 'friends',
  updated_at timestamptz not null default now()
);

create index human_context_current_area_id_idx on public.human_context (current_area_id);
create index human_context_current_city_id_idx on public.human_context (current_city_id);
create index human_context_home_city_id_idx on public.human_context (home_city_id);

create trigger human_context_touch_updated_at
  before update on public.human_context
  for each row execute function earth.touch_updated_at();

create table public.push_tokens (
  human_id uuid not null references public.humans (id) on delete cascade,
  token text not null,
  platform text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint push_tokens_pkey primary key (human_id, token),
  constraint push_tokens_token_check check (length(token) between 1 and 4096),
  constraint push_tokens_platform_check check (platform in ('ios', 'android', 'web'))
);

create index push_tokens_token_idx on public.push_tokens (token);

create trigger push_tokens_touch_updated_at
  before update on public.push_tokens
  for each row execute function earth.touch_updated_at();

alter table public.human_presence enable row level security;
alter table public.human_context enable row level security;
alter table public.push_tokens enable row level security;
