'use client'

/**
 * `/earth` — SCREEN 20. The screen reads `?place`, `?share` and `?you` (spec §75, SCREEN 24), so
 * it renders inside a Suspense boundary as `useSearchParams` requires for prerendering.
 */
import { Suspense } from 'react'

import { EarthScreen } from '../../../components/map/EarthScreen'
import { Spinner } from '../../../components/ui/Spinner'

function EarthFallback() {
  return (
    <div className="flex flex-1 items-center justify-center py-16">
      <Spinner />
    </div>
  )
}

export default function EarthPage() {
  return (
    <Suspense fallback={<EarthFallback />}>
      <EarthScreen />
    </Suspense>
  )
}
