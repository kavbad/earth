/**
 * Where a message's media is rendered from, and with what: the server tier's media route
 * (`mediaRouteUrl`, spec §104), which authorizes the viewer and redirects to a short-lived signed
 * URL, plus the request headers a native source needs to be that viewer (`features/media`). No
 * signing happens here: the `media` and `voice` buckets admit their owner only (0997), so a URL
 * signed on this side would work for the sender and for nobody who received the message.
 */
import { mediaRouteUrl } from '@earth/api'

import { type MediaRequestHeaders, useMediaRequestHeaders } from '@/features/media/requestHeaders'
import { usePublicEnv } from '@/lib/providers'

import type { MediaPayload } from '../payloads'

export interface MediaUrl {
  readonly url: string | null
  /** Sent with every request for `url`: the session, as the media route expects it. */
  readonly headers: MediaRequestHeaders
  /** The environment (and with it the API origin) has not arrived yet. */
  readonly loading: boolean
  readonly error: boolean
}

export function useMediaUrl(media: MediaPayload | null): MediaUrl {
  const env = usePublicEnv()
  const headers = useMediaRequestHeaders()
  if (media === null) return { url: null, headers, loading: false, error: false }
  if (env === null) return { url: null, headers, loading: true, error: false }
  return {
    url: mediaRouteUrl(env.API_BASE_URL, media.bucket, media.storageKey),
    headers,
    loading: false,
    error: false,
  }
}
