/**
 * An area by id (`area_get`), kept for the session: the current city's centroid centres the map
 * for Neighborhood / City (spec §52), the home city centres "Your Earth" (SCREEN 24).
 */
import { type AreaDto, asAreaId } from '@earth/domain'
import { type UseQueryResult, useQuery } from '@tanstack/react-query'

import { useEarthShell } from '../shell'

export const AREA_QUERY_KEY = 'area' as const

export function useArea(areaId: string | null): UseQueryResult<AreaDto> {
  const shell = useEarthShell()
  const { earth } = shell
  return useQuery({
    queryKey: [AREA_QUERY_KEY, areaId],
    queryFn: () => earth.location.getArea(asAreaId(areaId ?? '')),
    enabled: shell.ready && areaId !== null,
    staleTime: Number.POSITIVE_INFINITY,
  })
}
