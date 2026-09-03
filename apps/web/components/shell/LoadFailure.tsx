'use client'

/**
 * A public page whose server render could not reach Earth for a passing reason — a dropped
 * connection, a timeout, a throttle (`isTransientFailure`). Spec §107: a device that cannot reach
 * Earth reads "Waiting for connection", never a generic error. Spec §110: a failed load is one
 * quiet line and a way to try again, never a page-sized error that claims the thing is gone.
 *
 * Permanent answers — a dead invite, an ended room — are stated by the page itself instead.
 */
import { copy } from '@earth/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { ReactNode } from 'react'

import { webCopy } from '../../lib/copy'
import { useOnline } from '../../lib/providers/OfflineProvider'
import { ROUTES } from '../../lib/routes'
import { Button } from '../ui/Button'

export interface LoadFailureViewProps {
  readonly online: boolean
  readonly onRetry: () => void
  /** The way out of the failure (a link home); passed in so the view stays presentational. */
  readonly back: ReactNode
}

export function LoadFailureView({ online, onRetry, back }: LoadFailureViewProps) {
  return (
    <section className="fade-in flex flex-1 flex-col items-start gap-4 py-8">
      <p role="status" className="text-section">
        {online ? copy.couldntRefresh : copy.waitingForConnection}
      </p>
      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={onRetry}>
          {copy.tryAgain}
        </Button>
        {back}
      </div>
    </section>
  )
}

export function LoadFailure() {
  const online = useOnline()
  const router = useRouter()
  return (
    <LoadFailureView
      online={online}
      onRetry={() => router.refresh()}
      back={
        <Link
          href={ROUTES.home}
          className="min-h-touch-target inline-flex items-center text-body text-earth-accent"
        >
          {webCopy.backToEarth}
        </Link>
      }
    />
  )
}
