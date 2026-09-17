'use client'

import type { AreaId } from '@earth/domain'
import { useQuery } from '@tanstack/react-query'

import { useEarth, useRuntime } from '../../../lib/providers/RuntimeProvider'

export const AREA_QUERY_KEY = 'area' as const

/** `area_get(id).name`, cached for the session (home city name for the City switch). */
export function useAreaName(areaId: AreaId | null): string | null {
  const earth = useEarth()
  const { runtime } = useRuntime()
  const query = useQuery({
    queryKey: [AREA_QUERY_KEY, areaId],
    queryFn: () => earth.location.getArea(areaId ?? ('' as AreaId)),
    enabled: runtime !== null && areaId !== null,
    staleTime: 60 * 60_000,
  })
  return query.data?.name ?? null
}
