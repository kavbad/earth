import { copy } from '@earth/ui'
import type { Metadata } from 'next'
import { Suspense } from 'react'

import { SearchScreen } from '../../../components/feed/search/SearchScreen'

export const metadata: Metadata = { title: copy.search }

/** SCREEN 21 — Search (`?q=` preselects a query). */
export default function SearchPage() {
  return (
    <Suspense fallback={null}>
      <SearchScreen />
    </Suspense>
  )
}
