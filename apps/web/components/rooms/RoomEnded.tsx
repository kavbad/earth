'use client'

import type { EarthErrorCode } from '@earth/domain'
import { copy } from '@earth/ui'
import Link from 'next/link'
import type { Route } from 'next'

import { useOnline } from '../../lib/providers/OfflineProvider'
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

/**
 * What the closed room says. Spec §107: Live needs the network, and a room that could not be
 * opened because the device cannot reach Earth says exactly that instead of implying the room
 * itself is broken. The settled answers — ended, removed, not visible — do not depend on it.
 */
export function roomClosedLine(kind: RoomClosedKind, online: boolean): string {
  switch (kind) {
    case 'ended':
      return roomCopy.roomEnded
    case 'removed':
      return roomCopy.removedFromRoom
    case 'not_visible':
      return roomCopy.roomNotVisible
    case 'error':
      return online ? roomCopy.couldntOpenRoom : copy.connectionUnavailable
    default: {
      const exhaustive: never = kind
      throw new Error(`Unknown closed kind: ${String(exhaustive)}`)
    }
  }
}

/** The quiet end state: one line and a way back — never a giant error (spec §110 spirit). */
export function RoomEnded({ kind, backHref, onRetry }: RoomEndedProps) {
  const online = useOnline()
  const line = roomClosedLine(kind, online)
  return (
    <div className="fade-in flex flex-1 flex-col items-start justify-center gap-4 px-screen-margin py-8">
      <p className="text-section">{line}</p>
      <div className="flex items-center gap-3">
        {kind === 'error' && onRetry !== undefined ? (
          <Button variant="primary" onClick={onRetry}>
            {copy.tryAgain}
          </Button>
        ) : null}
        <Link
          href={backHref}
          className="min-h-touch-target inline-flex items-center text-body text-earth-accent"
        >
          {roomCopy.backToLive}
        </Link>
      </div>
    </div>
  )
}
