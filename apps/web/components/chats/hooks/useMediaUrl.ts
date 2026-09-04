'use client'

/**
 * Signed URLs for private media (`media` / `voice` buckets) through `media.signedUrl`, cached per
 * storage key for a little under the URL's lifetime so scrolling back never re-signs.
 */
import { DEFAULT_SIGNED_URL_SECONDS, STORAGE_BUCKETS } from '@earth/api'
import { useQuery } from '@tanstack/react-query'

import { useEarth, useRuntime } from '../../../lib/providers/RuntimeProvider'
import type { MediaPayload } from '../payloads'

const SIGNED_URL_STALE_MS = (DEFAULT_SIGNED_URL_SECONDS - 300) * 1_000

export interface MediaUrl {
  readonly url: string | null
  readonly loading: boolean
  readonly error: boolean
}

export function useMediaUrl(media: MediaPayload | null): MediaUrl {
  const earth = useEarth()
  const { runtime } = useRuntime()
  const query = useQuery({
    queryKey: ['media-url', media?.bucket ?? null, media?.storageKey ?? null],
    queryFn: () => {
      if (media === null) return Promise.resolve<string | null>(null)
      if (media.bucket === STORAGE_BUCKETS.avatars) {
        // Public bucket; the signed route still works but is unnecessary.
        return earth.media.signedUrl(media.bucket, media.storageKey)
      }
      return earth.media.signedUrl(media.bucket, media.storageKey)
    },
    enabled: runtime !== null && media !== null,
    staleTime: SIGNED_URL_STALE_MS,
    gcTime: SIGNED_URL_STALE_MS,
    retry: 1,
  })
  return {
    url: query.data ?? null,
    loading: media !== null && query.isPending,
    error: query.isError,
  }
}
