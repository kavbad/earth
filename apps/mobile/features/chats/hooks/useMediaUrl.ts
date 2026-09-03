/**
 * Signed URLs for private media (`media` / `voice` buckets) through `media.signedUrl`, cached per
 * storage key for a little under the URL's lifetime so scrolling back never re-signs.
 */
import { DEFAULT_SIGNED_URL_SECONDS } from '@earth/api'
import { useQuery } from '@tanstack/react-query'

import type { MediaPayload } from '../payloads'
import { useChatsShell } from '../shell'

const SIGNED_URL_STALE_MS = (DEFAULT_SIGNED_URL_SECONDS - 300) * 1_000

export interface MediaUrl {
  readonly url: string | null
  readonly loading: boolean
  readonly error: boolean
}

export function useMediaUrl(media: MediaPayload | null): MediaUrl {
  const { earth, isHuman } = useChatsShell()
  const query = useQuery({
    queryKey: ['media-url', media?.bucket ?? null, media?.storageKey ?? null],
    queryFn: () =>
      media === null
        ? Promise.resolve<string | null>(null)
        : earth.media.signedUrl(media.bucket, media.storageKey),
    enabled: isHuman && media !== null,
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
