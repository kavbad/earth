-- Storage buckets and object policies (ARCHITECTURE §5, spec §10).
-- Guarded on the `storage` schema, which a hosted Supabase project gets from its Storage service and
-- a plain Postgres gets from the Supabase shim (supabase/tests/sql/supabase_shim.sql block 6). Both
-- the local stack and the test database therefore run everything below: the local Storage service
-- (scripts/local-stack/storage.mjs) authorizes every upload and download with exactly these policies,
-- and supabase/tests/src/storage/objects.test.ts asserts them row by row. The guard remains for a
-- database that has neither (a bare psql target), where this file is a no-op.
--
-- Object keys follow `<human_id>/<random>.<ext>` (packages/api identity.uploadMedia), so ownership is
-- the first path segment compared with earth.current_human_id().
do $$
begin
  if not exists (select 1 from pg_namespace where nspname = 'storage') then
    raise notice 'storage schema absent: skipping bucket setup';
    return;
  end if;
  if not exists (select 1 from pg_tables where schemaname = 'storage' and tablename = 'buckets') then
    raise notice 'storage.buckets absent: skipping bucket setup';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values
    ('avatars', 'avatars', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/heic']),
    ('media', 'media', false, 104857600, array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'video/mp4', 'video/quicktime', 'video/webm']),
    ('voice', 'voice', false, 26214400, array['audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/webm', 'audio/ogg', 'audio/wav'])
  on conflict (id) do update
    set public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  -- Policies are recreated idempotently. Reads of private buckets go through server-signed URLs
  -- (service role), so client reads are restricted to the owner.
  execute 'drop policy if exists earth_avatars_public_read on storage.objects';
  execute $p$create policy earth_avatars_public_read on storage.objects for select
    using (bucket_id = 'avatars')$p$;

  execute 'drop policy if exists earth_private_owner_read on storage.objects';
  execute $p$create policy earth_private_owner_read on storage.objects for select to authenticated
    using (bucket_id in ('media', 'voice')
      and (storage.foldername(name))[1] = earth.current_human_id()::text)$p$;

  execute 'drop policy if exists earth_owner_write on storage.objects';
  execute $p$create policy earth_owner_write on storage.objects for insert to authenticated
    with check (bucket_id in ('avatars', 'media', 'voice')
      and earth.current_human_id() is not null
      and (storage.foldername(name))[1] = earth.current_human_id()::text)$p$;

  execute 'drop policy if exists earth_owner_update on storage.objects';
  execute $p$create policy earth_owner_update on storage.objects for update to authenticated
    using ((storage.foldername(name))[1] = earth.current_human_id()::text)
    with check ((storage.foldername(name))[1] = earth.current_human_id()::text)$p$;

  execute 'drop policy if exists earth_owner_delete on storage.objects';
  execute $p$create policy earth_owner_delete on storage.objects for delete to authenticated
    using ((storage.foldername(name))[1] = earth.current_human_id()::text)$p$;
end
$$;
