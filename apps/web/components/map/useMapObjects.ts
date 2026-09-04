'use client'

/**
 * `map_objects(scope, bbox)` for the settled camera box (SCREEN 20), cached per scope + box so
 * panning back is instant, refreshed while the map is open; plus the viewer's Live list so
 * Lives on the map carry faces. Cached objects stay while a refresh fails (spec §110).
 */
import type { LiveListDto, MapObjectsDto, Scope } from '@earth/domain'
import { type UseQueryResult, keepPreviousData, useQuery } from '@tanstack/react-query'

import { useEarth, useRuntime } from '../../lib/providers/RuntimeProvider'
import { useSession } from '../../lib/providers/SessionProvider'
import { LIVE_QUERY_KEY, LIVE_REFRESH_INTERVAL_MS } from '../live/LiveList'
import { boundsKey, clampBounds, roundBounds } from './state/view'
import type { MapBounds } from './types'

export const MAP_QUERY_KEY = 'map' as const
export const MAP_REFRESH_INTERVAL_MS = 30_000

export interface UseMapObjectsInput {
  readonly scope: Scope
  readonly bounds: MapBounds | null
  readonly enabled: boolean
}

export function useMapObjects({
  scope,
  bounds,
  enabled,
}: UseMapObjectsInput): UseQueryResult<MapObjectsDto> {
  const { runtime } = useRuntime()
  const earth = useEarth()
  const session = useSession()
  const key = bounds === null ? null : boundsKey(bounds)
  return useQuery({
    queryKey: [MAP_QUERY_KEY, scope, key, session.humanId],
    queryFn: () => {
      if (bounds === null) throw new Error('bounds required')
      return earth.map.objects(scope, roundBounds(clampBounds(bounds)))
    },
    enabled: enabled && runtime !== null && session.status === 'ready' && key !== null,
    placeholderData: keepPreviousData,
    refetchInterval: MAP_REFRESH_INTERVAL_MS,
  })
}

/** The same query Live Home uses, so faces are shared through the cache. */
export function useLiveCards(scope: Scope, enabled: boolean): UseQueryResult<LiveListDto> {
  const { runtime } = useRuntime()
  const earth = useEarth()
  const session = useSession()
  return useQuery({
    queryKey: [LIVE_QUERY_KEY, scope, session.humanId],
    queryFn: () => earth.live.list(scope),
    enabled: enabled && runtime !== null && session.status === 'ready',
    refetchInterval: LIVE_REFRESH_INTERVAL_MS,
    placeholderData: keepPreviousData,
  })
}
