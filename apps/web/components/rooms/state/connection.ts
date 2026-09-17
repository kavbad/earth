/**
 * What the Active Room says about its media connection (spec §107 "Live requires network and
 * should clearly say connection unavailable"; §109 "Reconnecting…", then "Couldn't reconnect" —
 * "Try again" / "Leave"). Pure: the overlay renders exactly this, the screens decide nothing.
 *
 * A `disconnected` state is only quiet when Earth asked for it (`CLIENT_INITIATED`: leaving,
 * a token refresh). Any other terminal drop — a duplicate identity from a second tab, an unknown
 * reason — is a lost connection the person must be able to retry or leave, never a frozen stage.
 */
import { type LiveKitStateDetail, NETWORK_UNAVAILABLE_REASON } from '@earth/realtime'
import { copy } from '@earth/ui'

import { roomCopy } from '../copy'

/** The five states of `useMediaConnection`, plus `idle` before the first connect. */
export const MEDIA_CONNECTION_STATUSES = [
  'idle',
  'connecting',
  'connected',
  'reconnecting',
  'failed',
  'disconnected',
] as const
export type MediaConnectionStatus = (typeof MEDIA_CONNECTION_STATUSES)[number]

/** The `detail.code` of a disconnect Earth itself asked for. */
export const CLIENT_INITIATED_CODE = 'CLIENT_INITIATED' as const

export type ConnectionPresentation =
  | { readonly kind: 'hidden' }
  /** Something is in progress: a spinner and one line. */
  | { readonly kind: 'busy'; readonly line: string }
  /** The connection is lost for good until the person acts: the line, "Try again", "Leave". */
  | { readonly kind: 'failed'; readonly line: string }

export interface ConnectionPresentationInput {
  readonly status: MediaConnectionStatus
  readonly detail: LiveKitStateDetail
  /** The device can reach Earth (`useOnline()`). */
  readonly online: boolean
}

/** A `disconnected` state nobody asked for (the SDK gave up with a terminal reason). */
export function isUnexpectedDisconnect(
  status: MediaConnectionStatus,
  detail: LiveKitStateDetail,
): boolean {
  return status === 'disconnected' && detail.code !== CLIENT_INITIATED_CODE
}

export function connectionPresentation(input: ConnectionPresentationInput): ConnectionPresentation {
  const { status, detail, online } = input
  const lost = status === 'failed' || isUnexpectedDisconnect(status, detail)
  if (lost) {
    return { kind: 'failed', line: online ? copy.couldntReconnect : copy.connectionUnavailable }
  }
  switch (status) {
    case 'idle':
    case 'disconnected':
      return { kind: 'hidden' }
    case 'connecting':
      return { kind: 'busy', line: online ? roomCopy.connecting : copy.connectionUnavailable }
    case 'reconnecting':
      return { kind: 'busy', line: online ? copy.reconnecting : copy.connectionUnavailable }
    case 'connected':
      // The SDK has not noticed yet; the person should (spec §107).
      return online ? { kind: 'hidden' } : { kind: 'busy', line: copy.connectionUnavailable }
    default: {
      const exhaustive: never = status
      throw new Error(`Unknown media status: ${String(exhaustive)}`)
    }
  }
}

/**
 * Whether the network coming back should retry on its own (spec §109 "attempt automatic
 * reconnect"): only a failure whose last attempts were skipped for lack of network. A real
 * server refusal stays on "Couldn't reconnect" until the person taps "Try again".
 */
export function shouldRetryWhenOnline(
  status: MediaConnectionStatus,
  detail: LiveKitStateDetail,
): boolean {
  return status === 'failed' && detail.code === NETWORK_UNAVAILABLE_REASON
}
