/**
 * The audience this Human last posted to on this device (SCREEN 06 "usually posts to"), read
 * once from the device store through react-query; `undefined` while it loads, `null` when
 * nothing is remembered (Visitors never have one).
 */
import type { Audience } from '@earth/domain'
import { type QueryClient, useQuery } from '@tanstack/react-query'

import { deviceStorage } from '@/lib/deviceStorage'
import { readString, writeString } from '@/lib/storage'

import { lastAudienceStorageKey, parseLastAudience } from '../state/audience'

export const LAST_AUDIENCE_QUERY_KEY = 'last-audience' as const

export function lastAudienceQueryKey(humanId: string | null) {
  return [LAST_AUDIENCE_QUERY_KEY, humanId] as const
}

export function useLastAudience(humanId: string | null): Audience | null | undefined {
  const query = useQuery({
    queryKey: lastAudienceQueryKey(humanId),
    queryFn: async () =>
      parseLastAudience(await readString(deviceStorage(), lastAudienceStorageKey(humanId ?? ''))),
    enabled: humanId !== null,
    staleTime: Infinity,
    gcTime: Infinity,
  })
  if (humanId === null) return null
  return query.isPending ? undefined : (query.data ?? null)
}

/** Writes the device store and the cache so the next composer opens on this audience. */
export function rememberLastAudience(
  queryClient: QueryClient,
  humanId: string | null,
  audience: Audience,
): void {
  if (humanId === null) return
  queryClient.setQueryData(lastAudienceQueryKey(humanId), audience)
  void writeString(deviceStorage(), lastAudienceStorageKey(humanId), audience)
}
