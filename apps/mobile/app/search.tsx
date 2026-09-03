import { useLocalSearchParams } from 'expo-router'

import { SearchScreen } from '@/components/feed/search/SearchScreen'
import { SEARCH_QUERY_PARAM, firstParam } from '@/features/feed/routes'

/** `/search` — SCREEN 21 (`?q=` preselects a query). */
export default function SearchRoute() {
  const params = useLocalSearchParams<{ [SEARCH_QUERY_PARAM]?: string | string[] }>()
  const initial = firstParam(params[SEARCH_QUERY_PARAM]) ?? ''
  return <SearchScreen key={initial} initialQuery={initial} />
}
