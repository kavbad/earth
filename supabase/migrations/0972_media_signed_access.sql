-- 0972 — signed access for private media (spec §104; ARCHITECTURE §5 "Storage buckets", §6).
--
-- `earth.media_url()` (0410) points every post media item at the server tier's media route
-- (`<web_origin>/api/media/<bucket>/<storage_key>`), which signs the object with the service role.
-- The route must not sign anything the caller may not see, so the authorization lives here, next
-- to the visibility rules it reuses:
--
--   * `earth.media_readable_by(media_id, viewer)` — the canonical read predicate for one media
--     object: the public `avatars` bucket (0997 `earth_avatars_public_read`), the owner, a viewer
--     who may see a post the object is attached to (`earth.can_view_post`, so blocks, audience and
--     removed posts all apply), or a member of a conversation whose message carries the object.
--   * `public.media_access_grant(bucket, storage_key)` — what the route calls **as the caller**:
--     the object when it may be read, `forbidden` otherwise. An object that is not registered in
--     `media_objects` answers the same way, so the route never reveals what exists in Storage.
--
-- Visitors read as `null` (world posts only), exactly like every other read path; Guests too
-- (`earth.viewer_human()`), and the service reads everything.

-- ---------------------------------------------------------------------------------------------------
-- Read predicate
-- ---------------------------------------------------------------------------------------------------

create or replace function earth.media_readable_by(p_media_id uuid, p_viewer uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_media public.media_objects%rowtype;
begin
  if p_media_id is null then
    return false;
  end if;
  select * into v_media from public.media_objects m where m.id = p_media_id;
  if not found then
    return false;
  end if;
  -- The avatars bucket is public read (0997); its URLs are handed out by every identity DTO.
  if v_media.bucket = 'avatars' then
    return true;
  end if;
  if p_viewer is not null and v_media.owner_human_id = p_viewer then
    return true;
  end if;
  if exists (
    select 1
      from public.post_media pm
     where pm.media_object_id = v_media.id
       and earth.can_view_post(pm.post_id, p_viewer)
  ) then
    return true;
  end if;
  -- Message media (spec §27 `payload`): the clients write `mediaObjectId` into the payload.
  if p_viewer is not null and exists (
    select 1
      from public.messages msg
     where msg.deleted_at is null
       and msg.payload ->> 'mediaObjectId' = v_media.id::text
       and earth.is_conversation_member(msg.conversation_id, p_viewer)
  ) then
    return true;
  end if;
  return false;
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Route RPC (server tier, as the caller)
-- ---------------------------------------------------------------------------------------------------

create or replace function public.media_access_grant(bucket text, storage_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_kind text := earth.current_role_kind();
  v_viewer uuid := earth.viewer_human();
  v_bucket text := nullif(btrim(coalesce(media_access_grant.bucket, '')), '');
  v_key text := nullif(btrim(coalesce(media_access_grant.storage_key, '')), '');
  v_media public.media_objects%rowtype;
begin
  if v_bucket is null or v_key is null then
    perform earth.raise('invalid_input', 'bucket and storage_key are required');
  end if;
  select * into v_media
    from public.media_objects m
   where m.bucket = v_bucket
     and m.storage_key = v_key;
  if not found or (v_kind <> 'service' and not earth.media_readable_by(v_media.id, v_viewer)) then
    perform earth.raise('forbidden');
  end if;
  return jsonb_build_object(
    'mediaObjectId', v_media.id,
    'bucket', v_media.bucket,
    'storageKey', v_media.storage_key,
    'contentType', v_media.content_type,
    'isPublic', v_media.bucket = 'avatars'
  );
end
$$;

-- ---------------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------------

revoke execute on function public.media_access_grant(text, text) from public;
grant execute on function public.media_access_grant(text, text) to anon, authenticated, service_role;
