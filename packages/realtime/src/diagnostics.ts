/**
 * Structural mirror of the RTC diagnostic events this package emits (spec §14 "every
 * realtime/video failure must emit diagnostic data"; ARCHITECTURE §8).
 *
 * `@earth/observability` owns the full `RtcDiagnosticEvent` contract and `createRtcDiagnostics`.
 * This package does not depend on it: apps inject the emitter, and every event type below is a
 * structural subset of the observability union (same `kind` literals, same optional fields), so
 * `createRtcDiagnostics(...)` satisfies `RealtimeDiagnostics` without an adapter. Keep the kinds
 * and field names in sync with `packages/observability/src/rtc.ts` `RTC_DIAGNOSTIC_KINDS`.
 */
import type { ConversationId, MediaIdentity, RoomId } from '@earth/domain'

/** Supabase Realtime channels that can fall back to polling (ARCHITECTURE §8). */
export const REALTIME_CHANNEL_KINDS = ['conversation', 'room', 'presence'] as const
export type RealtimeChannelKind = (typeof REALTIME_CHANNEL_KINDS)[number]

export const RTC_MEDIA_PERMISSIONS = ['microphone', 'camera'] as const
export type RtcMediaPermission = (typeof RTC_MEDIA_PERMISSIONS)[number]

export const RTC_TRACK_SOURCES = ['microphone', 'camera', 'screen_share'] as const
export type RtcTrackSource = (typeof RTC_TRACK_SOURCES)[number]

export interface RealtimeDiagnosticBase {
  readonly roomId?: RoomId
  readonly conversationId?: ConversationId
  readonly participantIdentity?: MediaIdentity
  /** Attempt counter for connect/reconnect/retry sequences (1 for the first attempt). */
  readonly attempt?: number
  /** Time the transition took, in milliseconds. */
  readonly durationMs?: number
  /** Free-text reason from the SDK or the app; never user content. */
  readonly reason?: string
  /** Machine code from the SDK, the server (`EarthErrorCode`) or HTTP. */
  readonly code?: string
}

export interface ConnectAttemptDiagnostic extends RealtimeDiagnosticBase {
  readonly kind: 'connect_attempt'
}
export interface ConnectedDiagnostic extends RealtimeDiagnosticBase {
  readonly kind: 'connected'
}
export interface ConnectFailedDiagnostic extends RealtimeDiagnosticBase {
  readonly kind: 'connect_failed'
}
export interface ReconnectingDiagnostic extends RealtimeDiagnosticBase {
  readonly kind: 'reconnecting'
}
export interface ReconnectFailedDiagnostic extends RealtimeDiagnosticBase {
  readonly kind: 'reconnect_failed'
}
export interface DisconnectedDiagnostic extends RealtimeDiagnosticBase {
  readonly kind: 'disconnected'
}
export interface NetworkUnavailableDiagnostic extends RealtimeDiagnosticBase {
  readonly kind: 'network_unavailable'
}
export interface MediaPermissionDeniedDiagnostic extends RealtimeDiagnosticBase {
  readonly kind: 'media_permission_denied'
  readonly permission?: RtcMediaPermission
}
export interface MediaDeviceErrorDiagnostic extends RealtimeDiagnosticBase {
  readonly kind: 'media_device_error'
  readonly source?: RtcTrackSource
}
export interface TrackPublishFailedDiagnostic extends RealtimeDiagnosticBase {
  readonly kind: 'track_publish_failed'
  readonly source?: RtcTrackSource
}
/** A remote participant's track could not be subscribed (they are in the room but unseen/unheard). */
export interface TrackSubscribeFailedDiagnostic extends RealtimeDiagnosticBase {
  readonly kind: 'track_subscribe_failed'
  readonly source?: RtcTrackSource
}
export interface RealtimeFallbackDiagnostic extends RealtimeDiagnosticBase {
  readonly kind: 'realtime_fallback'
  readonly channel?: RealtimeChannelKind
}
export interface RealtimeRecoveredDiagnostic extends RealtimeDiagnosticBase {
  readonly kind: 'realtime_recovered'
  readonly channel?: RealtimeChannelKind
}
export interface RealtimePollFailedDiagnostic extends RealtimeDiagnosticBase {
  readonly kind: 'realtime_poll_failed'
  readonly channel?: RealtimeChannelKind
}
export interface MessageSendFailedDiagnostic extends RealtimeDiagnosticBase {
  readonly kind: 'message_send_failed'
}

export type RealtimeDiagnosticEvent =
  | ConnectAttemptDiagnostic
  | ConnectedDiagnostic
  | ConnectFailedDiagnostic
  | ReconnectingDiagnostic
  | ReconnectFailedDiagnostic
  | DisconnectedDiagnostic
  | NetworkUnavailableDiagnostic
  | MediaPermissionDeniedDiagnostic
  | MediaDeviceErrorDiagnostic
  | TrackPublishFailedDiagnostic
  | TrackSubscribeFailedDiagnostic
  | RealtimeFallbackDiagnostic
  | RealtimeRecoveredDiagnostic
  | RealtimePollFailedDiagnostic
  | MessageSendFailedDiagnostic

export type RealtimeDiagnosticKind = RealtimeDiagnosticEvent['kind']

/**
 * The emitter this package needs. `createRtcDiagnostics(...)` from `@earth/observability`
 * satisfies it; its `emit` never rejects, and this package never awaits it.
 */
export interface RealtimeDiagnostics {
  emit(event: RealtimeDiagnosticEvent): unknown
}

/** Emits nothing; the default when an app does not wire diagnostics. */
export const noopDiagnostics: RealtimeDiagnostics = {
  emit: () => undefined,
}

/** Fires `emit` without awaiting it and without letting a throwing emitter break the call site. */
export function emitDiagnostic(
  diagnostics: RealtimeDiagnostics,
  event: RealtimeDiagnosticEvent,
): void {
  try {
    const result = diagnostics.emit(event)
    if (result instanceof Promise) {
      result.catch(() => undefined)
    }
  } catch {
    // Diagnostics are best effort.
  }
}
