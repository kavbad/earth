-- 0110 — media objects (DB_API §1 "media_objects").
--
-- One row per stored object (avatars, post media, message media, voice). Public URLs exist only for
-- the `avatars` bucket (earth.public_media_url in 0160); everything else is served through signed
-- URLs by the server tier. `owner_human_id` gets its foreign key in 0120 (humans does not exist yet).
-- RLS policies and grants live in 0170.

create table public.media_objects (
  id uuid primary key default gen_random_uuid(),
  owner_human_id uuid,
  bucket text not null,
  storage_key text not null,
  content_type text not null,
  width integer,
  height integer,
  duration_ms integer,
  byte_size bigint,
  created_at timestamptz not null default now(),
  constraint media_objects_bucket_check check (bucket in ('avatars', 'media', 'voice')),
  constraint media_objects_storage_key_check check (length(storage_key) between 1 and 512),
  constraint media_objects_content_type_check check (content_type ~ '^[a-z0-9.+-]+/[a-z0-9.+-]+$'),
  constraint media_objects_dimensions_check check (
    (width is null or width > 0) and (height is null or height > 0)
    and (duration_ms is null or duration_ms >= 0) and (byte_size is null or byte_size >= 0)
  ),
  constraint media_objects_bucket_key_key unique (bucket, storage_key)
);

create index media_objects_owner_human_id_idx on public.media_objects (owner_human_id);

alter table public.media_objects enable row level security;

-- Generic `updated_at` maintenance for the tables of this range.
create or replace function earth.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, earth, private, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end
$$;
