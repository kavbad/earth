import type { EarthErrorCode } from '@earth/domain'
import { copy } from '@earth/ui'
import Link from 'next/link'
import type { Route } from 'next'

import { Button } from '../ui/Button'
import { roomCopy } from './copy'

export const ROOM_CLOSED_KINDS = ['ended', 'removed', 'not_visible', 'error'] as const
export type RoomClosedKind = (typeof ROOM_CLOSED_KINDS)[number]

export function closedKindForError(code: EarthErrorCode): RoomClosedKind {
  switch (code) {
    case 'room_ended':
      return 'ended'
    case 'not_visible':
    case 'forbidden':
      return 'not_visible'
    default:
      return 'error'
  }
}

export interface RoomEndedProps {
  readonly kind: RoomClosedKind
  readonly backHref: Route
  readonly onRetry?: () => void
}

/** The quiet end state: one line and a way back — never a giant error (spec §110 spirit). */
export function RoomEnded({ kind, backHref, onRetry }: RoomEndedProps) {
  const line =
    kind === 'ended'
      ? roomCopy.roomEnded
      : kind === 'removed'
        ? roomCopy.removedFromRoom
        : kind === 'not_visible'
          ? roomCopy.roomNotVisible
          : roomCopy.couldntOpenRoom
  return (
    <div className="fade-in flex flex-1 flex-col items-start justify-center gap-4 px-screen-margin py-8">
      <p className="text-section">{line}</p>
      <div className="flex items-center gap-3">
        {kind === 'error' && onRetry !== undefined ? (
          <Button variant="primary" onClick={onRetry}>
            {copy.tryAgain}
          </Button>
        ) : null}
        <Link href={backHref} className="min-h-touch-target inline-flex items-center text-body text-earth-accent">
          {roomCopy.backToLive}
        </Link>
      </div>
    </div>
  )
}
