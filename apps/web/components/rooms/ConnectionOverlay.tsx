'use client'

import { copy } from '@earth/ui'

import { useOnline } from '../../lib/providers/OfflineProvider'
import { Button } from '../ui/Button'
import { Spinner } from '../ui/Spinner'
import { roomCopy } from './copy'
import type { MediaStatus } from './hooks/useMediaConnection'

export interface ConnectionOverlayProps {
  readonly status: MediaStatus
  readonly onRetry: () => void
  readonly onLeave: () => void
}

/**
 * Spec §109 over the stage: "Reconnecting…" while the SDK or Earth retries; "Couldn't reconnect"
 * with "Try again" / "Leave" once the policy is exhausted. Spec §107: Live needs network.
 */
export function ConnectionOverlay({ status, onRetry, onLeave }: ConnectionOverlayProps) {
  const online = useOnline()
  if (status === 'connected' || status === 'idle' || status === 'disconnected') return null
  const failed = status === 'failed'
  const line = !online
    ? copy.connectionUnavailable
    : failed
      ? copy.couldntReconnect
      : status === 'connecting'
        ? roomCopy.connecting
        : copy.reconnecting
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
