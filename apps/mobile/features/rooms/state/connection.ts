/**
 * The media connection as the room shows it (spec §107, §109): "Connecting…" on the way in,
 * "Reconnecting…" while the SDK or Earth retries, "Couldn't reconnect" with "Try again" /
 * "Leave" once the policy is exhausted, and "Connection unavailable" whenever the device has no
 * network — Live requires network and says so. Pure so the overlay is unit-tested.
 */
import { copy } from '@earth/ui'

import { roomCopy } from '../copy'

export const MEDIA_STATUSES = [
  'idle',
  'connecting',
  'connected',
  'reconnecting',
  'failed',
  'disconnected',
] as const
export type MediaStatus = (typeof MEDIA_STATUSES)[number]

export type ConnectionOverlayKind = 'none' | 'connecting' | 'reconnecting' | 'failed' | 'offline'

export interface ConnectionOverlayState {
  readonly kind: ConnectionOverlayKind
  /** The one line over the stage; `null` when nothing is shown. */
  readonly line: string | null
  /** A spinner next to the line (not while failed). */
  readonly spinner: boolean
  /** "Try again" / "Leave" (spec §109). */
  readonly actions: boolean
}

const HIDDEN: ConnectionOverlayState = { kind: 'none', line: null, spinner: false, actions: false }

export function connectionOverlay(status: MediaStatus, online: boolean): ConnectionOverlayState {
  if (status === 'connected' || status === 'idle' || status === 'disconnected') return HIDDEN
  if (!online) {
    return {
      kind: 'offline',
      line: copy.connectionUnavailable,
      spinner: status !== 'failed',
      actions: status === 'failed',
    }
  }
  if (status === 'failed') {
    return { kind: 'failed', line: copy.couldntReconnect, spinner: false, actions: true }
  }
  if (status === 'connecting') {
    return { kind: 'connecting', line: roomCopy.connecting, spinner: true, actions: false }
  }
  return { kind: 'reconnecting', line: copy.reconnecting, spinner: true, actions: false }
}
