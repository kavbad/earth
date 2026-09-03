'use client'

/**
 * SCREEN 21 data: one input, debounced, `search(q, limit)` through react-query keyed by the
 * query; `search_performed` once per answered query with the length and the result count —
 * never the text (spec §96).
 */
import type { SearchResultsDto } from '@earth/domain'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'

import { useAnalytics } from '../../../lib/providers/AnalyticsProvider'
import { useEarth, useRuntime } from '../../../lib/providers/RuntimeProvider'
import { useSession } from '../../../lib/providers/SessionProvider'

export const SEARCH_QUERY_KEY = 'search' as const
export const SEARCH_DEBOUNCE_MS = 300

export function resultCount(results: SearchResultsDto): number {
  return (
    results.people.length + results.groups.length + results.places.length + results.posts.length
  )
}

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
  const earth = useEarth()
  const { runtime } = useRuntime()
  const session = useSession()
  const analytics = useAnalytics()
  const query = useDebouncedValue(input.trim(), SEARCH_DEBOUNCE_MS)
  const enabled = runtime !== null && session.status === 'ready' && query.length > 0
  const result = useQuery({
    queryKey: [SEARCH_QUERY_KEY, session.humanId, query],
    queryFn: () => earth.search.query(query),
    enabled,
    staleTime: 60_000,
  })

  const tracked = useRef<string | null>(null)
  useEffect(() => {
    if (result.data === undefined || tracked.current === query) return
    tracked.current = query
    analytics.track('search_performed', {
      queryLength: query.length,
      resultCount: resultCount(result.data),
    })
  }, [analytics, query, result.data])

  return {
    query,
    results: enabled ? result.data : undefined,
    searching: enabled && result.isPending,
    failed: enabled && result.isError && result.data === undefined,
  }
}
