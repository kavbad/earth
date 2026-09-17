/**
 * `GET /api/media/:bucket/:key*` — signed access for private media (spec §104; ARCHITECTURE §5).
 *
 * `earth.media_url()` (migration 0410) points every post media item at this route, because the
 * `media` and `voice` buckets are private and their storage policy (0997) admits the owner only:
 * a recipient can never sign the object itself. So the route
 *
 *   1. authorizes the caller **in the database**, as the caller — `media_access_grant(bucket,
 *      storage_key)` answers with the object when the viewer may see a post (or a conversation
 *      message) it belongs to, and `forbidden` otherwise, never revealing what exists in Storage;
 *   2. mints a short-lived signed URL with the service-role Storage client and redirects to it.
 *
 * The redirect is what makes `<img src>` / `<video src>` work in both clients without any URL
 * juggling; it is `private` and short-lived so it is never shared by a cache between viewers.
 */
import { EarthError } from '@earth/domain'
import { z } from 'zod'

import type { ServerDeps } from '../deps'
import {
  CONTENT_TYPE_HEADER,
  type EarthRequest,
  type EarthResponse,
  HTTP_STATUS,
  optionalBearer,
  rpc,
} from '../http'

export const MEDIA_ACCESS_GRANT_RPC = 'media_access_grant' as const

/** Storage buckets (ARCHITECTURE §5; `media_objects_bucket_check` in 0110). */
export const MEDIA_BUCKETS = ['avatars', 'media', 'voice'] as const
export type MediaBucket = (typeof MEDIA_BUCKETS)[number]
export const MediaBucketSchema = z.enum(MEDIA_BUCKETS)

/** Lifetime of the signed URL the route redirects to. Short: the URL is a bearer of the object. */
export const MEDIA_SIGNED_URL_SECONDS = 300
/** How long a client may reuse the redirect. Under the signature's lifetime, and never shared. */
export const MEDIA_CACHE_SECONDS = 240
export const MEDIA_CACHE_CONTROL = `private, max-age=${MEDIA_CACHE_SECONDS}` as const
export const LOCATION_HEADER = 'location' as const
export const CACHE_CONTROL_HEADER = 'cache-control' as const

export const MEDIA_LOG = {
  signFailed: 'media.sign_failed',
  storageUnavailable: 'media.storage_unavailable',
} as const

/** What `media_access_grant(bucket, storage_key)` answers for a caller who may read the object. */
export const MediaAccessGrantSchema = z.object({
  mediaObjectId: z.uuid(),
  bucket: MediaBucketSchema,
  storageKey: z.string().min(1),
  contentType: z.string().min(1),
  isPublic: z.boolean(),
})
export type MediaAccessGrant = z.infer<typeof MediaAccessGrantSchema>

/** `302` to `location`; no body, so the redirect never carries anything about the object. */
export function redirect(
  location: string,
  headers: Readonly<Record<string, string>> = {},
): EarthResponse {
  return {
    status: HTTP_STATUS.found,
    headers: {
      [CONTENT_TYPE_HEADER]: 'text/plain; charset=utf-8',
      [LOCATION_HEADER]: location,
      ...headers,
    },
    body: undefined,
  }
}

export async function handleMediaSigned(
  deps: ServerDeps,
  req: EarthRequest,
  bucket: string,
  storageKey: string,
): Promise<EarthResponse> {
  const parsedBucket = MediaBucketSchema.safeParse(bucket)
  if (!parsedBucket.success || storageKey.length === 0) {
    // An unknown bucket is indistinguishable from an object the caller may not read.
    throw new EarthError('forbidden', { details: { reason: 'media_not_readable' } })
  }
  const token = optionalBearer(req)
  const grant = await rpc(
    deps,
    token,
    MEDIA_ACCESS_GRANT_RPC,
    { bucket: parsedBucket.data, storage_key: storageKey },
    MediaAccessGrantSchema,
  )
  const logger = deps.logger.child({ route: 'media.signed', bucket: grant.bucket })
  if (deps.storage === undefined) {
    logger.error(MEDIA_LOG.storageUnavailable, {})
    throw new EarthError('internal', {
      details: { reason: 'storage_unavailable' },
      message: 'storage client is not configured',
    })
  }
  let signed
  try {
    signed = await deps.storage
      .from(grant.bucket)
      .createSignedUrl(grant.storageKey, MEDIA_SIGNED_URL_SECONDS)
  } catch (cause) {
    logger.error(MEDIA_LOG.signFailed, { error: cause })
    throw new EarthError('internal', { cause, message: 'signed url failed' })
  }
  const url = signed.data?.signedUrl
  if (signed.error !== null || url === undefined || url.length === 0) {
    logger.error(MEDIA_LOG.signFailed, { message: signed.error?.message ?? 'no signed url' })
    throw new EarthError('internal', { message: 'signed url failed' })
  }
  return redirect(url, { [CACHE_CONTROL_HEADER]: MEDIA_CACHE_CONTROL })
}
