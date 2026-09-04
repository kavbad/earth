'use client'

import type { LiveKitStateDetail } from '@earth/realtime'
import { copy } from '@earth/ui'

import { useOnline } from '../../lib/providers/OfflineProvider'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import type { MediaStatus } from './hooks/useMediaConnection'
import { connectionPresentation } from './state/connection'

export interface ConnectionOverlayProps {
  readonly status: MediaStatus
  /** `useMediaConnection().detail` — tells a leave (`CLIENT_INITIATED`) from a drop. */
  readonly detail?: LiveKitStateDetail
  readonly onRetry: () => void
  readonly onLeave: () => void
}

const NO_DETAIL: LiveKitStateDetail = {}

/**
 * Spec §109 over the stage: "Reconnecting…" while the SDK or Earth retries; "Couldn't reconnect"
 * with "Try again" / "Leave" once the policy is exhausted — also after a drop nobody asked for
 * (`state/connection.ts`). Spec §107: while offline the line says connection unavailable.
 */
export function ConnectionOverlay({
  status,
  detail = NO_DETAIL,
  onRetry,
  onLeave,
}: ConnectionOverlayProps) {
  const online = useOnline()
  const presentation = connectionPresentation({ status, detail, online })
  if (presentation.kind === 'hidden') return null
  const failed = presentation.kind === 'failed'
  const { line } = presentation
  return (
    <div
      role="status"
      aria-live="polite"
      className="fade-in absolute inset-x-0 bottom-0 z-overlay flex flex-col items-center gap-3 bg-background/90 px-screen-margin py-4"
    >
      <div className="flex items-center gap-2 text-secondary text-text-primary">
        {failed ? null : <Spinner label={line} />}
        <span>{line}</span>
      </div>
      {failed ? (
        <div className="flex gap-2">
          <Button variant="primary" onClick={onRetry}>
            {copy.tryAgain}
          </Button>
          <Button variant="quiet" onClick={onLeave}>
            {copy.leave}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
