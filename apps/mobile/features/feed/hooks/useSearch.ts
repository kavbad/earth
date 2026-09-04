/**
 * SCREEN 21 data: one input, debounced, `search(q, limit)` through react-query keyed by the
 * query; `search_performed` once per answered query with the length and the result count —
 * never the text (spec §96).
 */
import type { SearchResultsDto } from '@earth/domain'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { useFeedShell } from '../shell'
import { resultCount } from '../state/search'

export const SEARCH_QUERY_KEY = 'search' as const
export const SEARCH_DEBOUNCE_MS = 300

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}

export interface SearchController {
  /** The query the results answer (debounced, trimmed). */
  readonly query: string
  readonly results: SearchResultsDto | undefined
  readonly searching: boolean
  readonly failed: boolean
}

export function useSearch(input: string): SearchController {
  const shell = useFeedShell()
  const { earth, track } = shell
  const query = useDebouncedValue(input.trim(), SEARCH_DEBOUNCE_MS)
  const enabled = shell.ready && query.length > 0
  const result = useQuery({
    queryKey: [SEARCH_QUERY_KEY, shell.viewerId, query],
    queryFn: () => earth.search.query(query),
    enabled,
    staleTime: 60_000,
  })

  const tracked = useRef<string | null>(null)
  useEffect(() => {
    if (result.data === undefined || tracked.current === query) return
    tracked.current = query
    track('search_performed', { queryLength: query.length, resultCount: resultCount(result.data) })
  }, [query, result.data, track])

  return {
    query,
    results: enabled ? result.data : undefined,
    searching: enabled && result.isPending,
    failed: enabled && result.isError && result.data === undefined,
  }
}
