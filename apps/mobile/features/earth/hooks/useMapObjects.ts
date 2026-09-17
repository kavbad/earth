/**
 * `map_objects(scope, bbox)` for the settled camera box (SCREEN 20), cached per viewer × scope ×
 * box so panning back is instant, refreshed while the map is open and the device is online;
 * plus the viewer's Live list so Lives on the map carry faces. Cached objects stay on screen
 * while a refresh fails (spec §110).
 */
import type { LiveListDto, MapObjectsDto, Scope } from '@earth/domain'
import { type UseQueryResult, keepPreviousData, useQuery } from '@tanstack/react-query'

import { useEarthShell } from '../shell'
import { type MapBounds, boundsKey, clampBounds, roundBounds } from '../state/view'

export const MAP_QUERY_KEY = 'map' as const
export const MAP_REFRESH_INTERVAL_MS = 30_000
/** The Live Home query (`components/live/LiveList`): the same key shape shares the cache. */
export const LIVE_QUERY_KEY = 'live' as const
export const LIVE_REFRESH_INTERVAL_MS = 30_000

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
  const shell = useEarthShell()
  const { earth } = shell
  const key = bounds === null ? null : boundsKey(bounds)
  return useQuery({
    queryKey: [MAP_QUERY_KEY, scope, key, shell.viewerId],
    queryFn: () => {
      if (bounds === null) throw new Error('bounds required')
      return earth.map.objects(scope, roundBounds(clampBounds(bounds)))
    },
    enabled: enabled && shell.ready && key !== null,
    placeholderData: keepPreviousData,
    refetchInterval: shell.online ? MAP_REFRESH_INTERVAL_MS : false,
  })
}

/** The same query Live Home uses, so faces are shared through the cache. */
export function useLiveCards(scope: Scope, enabled: boolean): UseQueryResult<LiveListDto> {
  const shell = useEarthShell()
  const { earth } = shell
  return useQuery({
    queryKey: [LIVE_QUERY_KEY, scope, shell.viewerId],
    queryFn: () => earth.live.list(scope),
    enabled: enabled && shell.ready,
    refetchInterval: shell.online ? LIVE_REFRESH_INTERVAL_MS : false,
    placeholderData: keepPreviousData,
  })
}
