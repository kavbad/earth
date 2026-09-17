/**
 * Why a room screen is closed: ended, removed, not visible to the viewer, or a read failure —
 * and the one quiet line each state shows (spec §107: offline, Live says the connection is
 * unavailable rather than a generic failure).
 */
import type { EarthErrorCode } from '@earth/domain'
import { copy } from '@earth/ui'

import { roomCopy } from '../copy'

export const ROOM_CLOSED_KINDS = ['ended', 'removed', 'not_visible', 'error'] as const
export type RoomClosedKind = (typeof ROOM_CLOSED_KINDS)[number]

/** The line of the closed-room screen. */
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

export function closedKindForError(code: EarthErrorCode): RoomClosedKind {
  switch (code) {
    case 'room_ended':
      return 'ended'
    case 'not_visible':
    case 'forbidden':
    case 'not_authenticated':
      return 'not_visible'
    default:
      return 'error'
  }
}

/** Errors that mean "this link goes nowhere any more" (room link preview / join). */
export function isLinkUnusable(code: EarthErrorCode): boolean {
  return code === 'invite_invalid' || code === 'invite_expired' || code === 'room_ended'
}
