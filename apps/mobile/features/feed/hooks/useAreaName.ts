import type { AreaId } from '@earth/domain'
import { useQuery } from '@tanstack/react-query'

import { useFeedShell } from '../shell'

export const AREA_QUERY_KEY = 'area' as const

/** `area_get(id).name`, cached for the session (home city name for the City switch). */
export function useAreaName(areaId: AreaId | null): string | null {
  const shell = useFeedShell()
  const query = useQuery({
    queryKey: [AREA_QUERY_KEY, areaId],
    queryFn: () => shell.earth.location.getArea(areaId ?? ('' as AreaId)),
    enabled: shell.ready && areaId !== null,
    staleTime: 60 * 60_000,
  })
  return query.data?.name ?? null
}
