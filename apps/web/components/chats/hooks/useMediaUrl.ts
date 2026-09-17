'use client'

/**
 * Where a message's media is rendered from: the server tier's media route (`mediaRouteUrl`,
 * spec §104), which authorizes the viewer and redirects to a short-lived signed URL. The browser
 * fetches it like any image — with the session cookie, which the route mount presents as the
 * bearer (`lib/server/cookie-bearer.ts`). No signing happens here: the `media` and `voice`
 * buckets admit their owner only (0997), so a URL signed on this side would work for the sender
 * and for nobody who received the message.
 */
import { mediaRouteUrl } from '@earth/api'

import { usePublicEnv } from '../../../lib/providers/RuntimeProvider'
import type { MediaPayload } from '../payloads'

export interface MediaUrl {
  readonly url: string | null
  /** The environment (and with it the API origin) has not arrived yet. */
  readonly loading: boolean
  readonly error: boolean
}

export function useMediaUrl(media: MediaPayload | null): MediaUrl {
  const env = usePublicEnv()
  if (media === null) return { url: null, loading: false, error: false }
  if (env === null) return { url: null, loading: true, error: false }
  return {
    url: mediaRouteUrl(env.API_BASE_URL, media.bucket, media.storageKey),
    loading: false,
    error: false,
  }
}
