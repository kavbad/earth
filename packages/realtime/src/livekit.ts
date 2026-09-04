/**
 * LiveKit connection wrapper (ARCHITECTURE §8 states `connecting | connected | reconnecting |
 * failed`; spec §109 "Reconnecting…" / "Couldn't reconnect" — "Try again" / "Leave"; spec §9:
 * LiveKit is the media transport, Earth owns the room model).
 *
 * The SDK is injected through `createRoom` and described structurally (`RoomLike`), so the same
 * code drives `livekit-client` on web and `@livekit/react-native`'s `Room` on mobile, and tests
 * use a fake room that emits events. The wrapper:
 *
 * - runs the initial connect with the reconnect policy (attempt 1 immediately, then backoff) and
 *   ends in `failed` (`connect_failed`) when exhausted;
 * - mirrors the SDK's own `Reconnecting` / `Reconnected` into `reconnecting` / `connected`;
 * - when the SDK gives up (`Disconnected` with a retryable reason) runs its own reconnect loop
 *   (`reconnecting` with attempt numbers, `reconnect_failed` when exhausted → `failed`);
 * - treats terminal reasons (removed, duplicate identity, room ended, client leave) as a clean
 *   `disconnected`;
 * - exposes `retry()` — the "Try again" button — from `failed` / `disconnected`;
 * - skips attempts while the injected `isOnline()` reports no network, emitting
 *   `network_unavailable` instead (spec §107: Live requires network) and still backing off;
 * - emits an `RtcDiagnosticEvent` for every transition with attempt counters and durations from
 *   the injected clock, plus `media_permission_denied` / `media_device_error` /
 *   `track_publish_failed` / `track_subscribe_failed` for device and track problems.
 */
import { type MediaIdentity, RECONNECT_POLICY, type RoomId } from '@earth/domain'

import { type CancellableDelay, type RealtimeClock, delay, errorReason, systemClock } from './clock'
import {
  type RealtimeDiagnostics,
  type RtcMediaPermission,
  type RtcTrackSource,
  emitDiagnostic,
  noopDiagnostics,
} from './diagnostics'

export const LIVEKIT_CONNECTION_STATES = [
  'connecting',
  'connected',
  'reconnecting',
  'failed',
  'disconnected',
] as const
export type LiveKitConnectionState = (typeof LIVEKIT_CONNECTION_STATES)[number]

/** `RoomEvent` string values of livekit-client (the SDK enum is not imported). */
export const LIVEKIT_ROOM_EVENTS = {
  connected: 'connected',
  reconnecting: 'reconnecting',
  reconnected: 'reconnected',
  disconnected: 'disconnected',
  connectionQualityChanged: 'connectionQualityChanged',
  mediaDevicesError: 'mediaDevicesError',
  trackSubscriptionFailed: 'trackSubscriptionFailed',
} as const
export type LiveKitRoomEvent = (typeof LIVEKIT_ROOM_EVENTS)[keyof typeof LIVEKIT_ROOM_EVENTS]

/** `ConnectionQuality` string values of livekit-client. */
export const LIVEKIT_CONNECTION_QUALITIES = [
  'excellent',
  'good',
  'poor',
  'lost',
  'unknown',
] as const
export type LiveKitConnectionQuality = (typeof LIVEKIT_CONNECTION_QUALITIES)[number]

/** `DisconnectReason` numeric values of `@livekit/protocol` (the enum is not imported). */
export const LIVEKIT_DISCONNECT_REASONS = {
  UNKNOWN_REASON: 0,
  CLIENT_INITIATED: 1,
  DUPLICATE_IDENTITY: 2,
  SERVER_SHUTDOWN: 3,
  PARTICIPANT_REMOVED: 4,
  ROOM_DELETED: 5,
  STATE_MISMATCH: 6,
  JOIN_FAILURE: 7,
  MIGRATION: 8,
  SIGNAL_CLOSE: 9,
  ROOM_CLOSED: 10,
  USER_UNAVAILABLE: 11,
  USER_REJECTED: 12,
  SIP_TRUNK_FAILURE: 13,
  CONNECTION_TIMEOUT: 14,
  MEDIA_FAILURE: 15,
} as const
export type LiveKitDisconnectReasonName = keyof typeof LIVEKIT_DISCONNECT_REASONS

/** Reasons after which reconnecting makes no sense: the participant or room is gone. */
export const TERMINAL_DISCONNECT_REASONS: ReadonlySet<number> = new Set<number>([
  LIVEKIT_DISCONNECT_REASONS.CLIENT_INITIATED,
  LIVEKIT_DISCONNECT_REASONS.DUPLICATE_IDENTITY,
  LIVEKIT_DISCONNECT_REASONS.PARTICIPANT_REMOVED,
  LIVEKIT_DISCONNECT_REASONS.ROOM_DELETED,
  LIVEKIT_DISCONNECT_REASONS.ROOM_CLOSED,
  LIVEKIT_DISCONNECT_REASONS.USER_REJECTED,
])

export function disconnectReasonName(reason: unknown): LiveKitDisconnectReasonName | undefined {
  if (typeof reason !== 'number') return undefined
  for (const [name, value] of Object.entries(LIVEKIT_DISCONNECT_REASONS)) {
    if (value === reason) return name as LiveKitDisconnectReasonName
  }
  return undefined
}

/** `SubscriptionError` numeric values of `@livekit/protocol` (`TrackSubscriptionFailed` reason). */
export const LIVEKIT_SUBSCRIPTION_ERRORS = {
  SE_UNKNOWN: 0,
  SE_CODEC_UNSUPPORTED: 1,
  SE_TRACK_NOTFOUND: 2,
} as const
export type LiveKitSubscriptionErrorName = keyof typeof LIVEKIT_SUBSCRIPTION_ERRORS

export function subscriptionErrorName(reason: unknown): LiveKitSubscriptionErrorName | undefined {
  if (typeof reason !== 'number') return undefined
  for (const [name, value] of Object.entries(LIVEKIT_SUBSCRIPTION_ERRORS)) {
    if (value === reason) return name as LiveKitSubscriptionErrorName
  }
  return undefined
}

/** `reason` / `code` of attempts skipped because the device reports no network (spec §107). */
export const NETWORK_UNAVAILABLE_REASON = 'network_unavailable' as const

/** Whether a drop with this SDK reason should trigger the automatic reconnect loop (spec §109). */
export function isRetryableDisconnect(reason: unknown): boolean {
  return typeof reason === 'number' ? !TERMINAL_DISCONNECT_REASONS.has(reason) : true
}

/** `MediaDeviceKind` values relevant to publishing. */
export const MEDIA_DEVICE_KINDS = { audioInput: 'audioinput', videoInput: 'videoinput' } as const

const PERMISSION_DENIED_ERROR_NAMES: ReadonlySet<string> = new Set([
  'NotAllowedError',
  'PermissionDeniedError',
  'SecurityError',
])

/** Browser / React Native errors that mean the user or OS denied camera or microphone access. */
export function isPermissionDeniedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const name = (error as { name?: unknown }).name
  if (typeof name === 'string' && PERMISSION_DENIED_ERROR_NAMES.has(name)) return true
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' && /permission denied/i.test(message)
}

// ---------------------------------------------------------------------------------------------
// Structural LiveKit types
// ---------------------------------------------------------------------------------------------

export interface LocalParticipantLike {
  setMicrophoneEnabled(enabled: boolean): Promise<unknown>
  setCameraEnabled(enabled: boolean): Promise<unknown>
}

export interface ParticipantLike {
  readonly identity: string
}

/** The slice of livekit-client's `Room` this wrapper drives; a `new Room()` satisfies it. */
export interface RoomLike {
  connect(url: string, token: string, options?: unknown): Promise<void>
  disconnect(stopTracks?: boolean): Promise<void>
  on(
    event:
      | typeof LIVEKIT_ROOM_EVENTS.connected
      | typeof LIVEKIT_ROOM_EVENTS.reconnecting
      | typeof LIVEKIT_ROOM_EVENTS.reconnected,
    listener: () => void,
  ): unknown
  on(event: typeof LIVEKIT_ROOM_EVENTS.disconnected, listener: (reason?: unknown) => void): unknown
  on(
    event: typeof LIVEKIT_ROOM_EVENTS.connectionQualityChanged,
    listener: (quality: string, participant: ParticipantLike) => void,
  ): unknown
  on(
    event: typeof LIVEKIT_ROOM_EVENTS.mediaDevicesError,
    listener: (error: Error, kind?: string) => void,
  ): unknown
  on(
    event: typeof LIVEKIT_ROOM_EVENTS.trackSubscriptionFailed,
    listener: (trackSid: string, participant: ParticipantLike, reason?: unknown) => void,
  ): unknown
  readonly localParticipant: LocalParticipantLike
}

export interface ReconnectPolicy {
  readonly attempts: number
  readonly backoffMs: readonly number[]
}

/** Five attempts, 500 ms → 8 s (`RECONNECT_POLICY` in `@earth/domain`). */
export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = RECONNECT_POLICY

export interface LiveKitStateDetail {
  readonly attempt?: number
  readonly reason?: string
  readonly code?: string
}

export type MediaToggleResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly kind: 'media_permission_denied' | 'track_publish_failed'
      readonly error: unknown
    }

export interface ConnectLiveKitOptions {
  readonly createRoom: () => RoomLike
  readonly url: string
  readonly token: string
  readonly roomId?: RoomId
  readonly participantIdentity?: MediaIdentity
  readonly onState?: (state: LiveKitConnectionState, detail: LiveKitStateDetail) => void
  readonly onQuality?: (quality: LiveKitConnectionQuality, participantIdentity: string) => void
  readonly diagnostics?: RealtimeDiagnostics
  readonly clock?: RealtimeClock
  readonly reconnectPolicy?: ReconnectPolicy
  /**
   * Device connectivity (`navigator.onLine`, NetInfo). While it returns `false` an attempt is not
   * made (it cannot succeed): `network_unavailable` is emitted and the policy's backoff still
   * runs, so the sequence ends in `failed` with reason `network_unavailable` if the network does
   * not return in time. Omitted → every attempt is made.
   */
  readonly isOnline?: () => boolean
  /** Passed through to `room.connect(url, token, options)`. */
  readonly connectOptions?: unknown
  /** Platform strategy for "flip camera" (front/back); omitted → `flipCamera` is absent. */
  readonly flipCamera?: (room: RoomLike) => Promise<boolean>
}

export interface LiveKitConnection {
  readonly room: RoomLike
  state(): LiveKitConnectionState
  /** Resolves with the state once the current connect / reconnect sequence settles. */
  settled(): Promise<LiveKitConnectionState>
  /** Leave: cancels any reconnect loop, disconnects the SDK, ends in `disconnected`. */
  disconnect(): Promise<void>
  /** "Try again" (spec §109): a fresh connect sequence from `failed` or `disconnected`. */
  retry(): Promise<LiveKitConnectionState>
  setMicrophoneEnabled(enabled: boolean): Promise<MediaToggleResult>
  setCameraEnabled(enabled: boolean): Promise<MediaToggleResult>
  readonly flipCamera?: () => Promise<boolean>
}

type SequencePhase = 'connect' | 'reconnect'

const QUALITY_SET: ReadonlySet<string> = new Set<string>(LIVEKIT_CONNECTION_QUALITIES)

function toQuality(value: string): LiveKitConnectionQuality {
  return QUALITY_SET.has(value) ? (value as LiveKitConnectionQuality) : 'unknown'
}

function permissionFor(kind: string | undefined): RtcMediaPermission | undefined {
  if (kind === MEDIA_DEVICE_KINDS.audioInput) return 'microphone'
  if (kind === MEDIA_DEVICE_KINDS.videoInput) return 'camera'
  return undefined
}

function sourceFor(kind: string | undefined): RtcTrackSource | undefined {
  if (kind === MEDIA_DEVICE_KINDS.audioInput) return 'microphone'
  if (kind === MEDIA_DEVICE_KINDS.videoInput) return 'camera'
  return undefined
}

export function connectLiveKit(options: ConnectLiveKitOptions): LiveKitConnection {
  const clock = options.clock ?? systemClock
  const diagnostics = options.diagnostics ?? noopDiagnostics
  const policy = options.reconnectPolicy ?? DEFAULT_RECONNECT_POLICY
  const room = options.createRoom()
  const scope = {
    ...(options.roomId === undefined ? {} : { roomId: options.roomId }),
    ...(options.participantIdentity === undefined
      ? {}
      : { participantIdentity: options.participantIdentity }),
  }

  let state: LiveKitConnectionState = 'connecting'
  let generation = 0
  let sequenceRunning = false
  let intentional = false
  let pendingDelay: CancellableDelay | null = null
  let sdkReconnectAttempts = 0
  let droppedAt: number | null = null
  let settledPromise: Promise<LiveKitConnectionState> = Promise.resolve(state)

  const setState = (next: LiveKitConnectionState, detail: LiveKitStateDetail = {}): void => {
    state = next
    options.onState?.(next, detail)
  }

  /** Delay before retry number `retry` (1-based); the last configured value repeats. */
  const backoffFor = (retry: number): number => {
    const configured = policy.backoffMs[retry - 1] ?? policy.backoffMs[policy.backoffMs.length - 1]
    return configured ?? 0
  }

  const runSequence = async (
    phase: SequencePhase,
    startedAt: number,
  ): Promise<LiveKitConnectionState> => {
    const myGeneration = ++generation
    sequenceRunning = true
    let lastReason: string | undefined = undefined
    try {
      for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
        if (myGeneration !== generation) return state
        if (phase === 'connect') {
          setState('connecting', { attempt })
          emitDiagnostic(diagnostics, { kind: 'connect_attempt', ...scope, attempt })
        } else {
          setState('reconnecting', { attempt })
          emitDiagnostic(diagnostics, { kind: 'reconnecting', ...scope, attempt })
        }
        // Connecting tries at once and backs off before each retry; reconnecting backs off before
        // every attempt (the drop just happened), so reconnect attempt N is retry N.
        const retry = phase === 'connect' ? attempt - 1 : attempt
        if (retry > 0) {
          pendingDelay = delay(clock, backoffFor(retry))
          await pendingDelay.promise
          pendingDelay = null
          if (myGeneration !== generation) return state
        }
        if (options.isOnline?.() === false) {
          // Live requires network (spec §107): do not burn a socket attempt that cannot succeed.
          lastReason = NETWORK_UNAVAILABLE_REASON
          emitDiagnostic(diagnostics, {
            kind: 'network_unavailable',
            ...scope,
            attempt,
            code: NETWORK_UNAVAILABLE_REASON,
          })
          continue
        }
        try {
          await room.connect(options.url, options.token, options.connectOptions)
          if (myGeneration !== generation) return state
          const durationMs = clock.now() - startedAt
          setState('connected', { attempt })
          emitDiagnostic(diagnostics, { kind: 'connected', ...scope, attempt, durationMs })
          return state
        } catch (error) {
          lastReason = errorReason(error)
          if (myGeneration !== generation) return state
        }
      }
      const durationMs = clock.now() - startedAt
      const reason = lastReason
      const code = reason === NETWORK_UNAVAILABLE_REASON ? NETWORK_UNAVAILABLE_REASON : undefined
      const detail: LiveKitStateDetail = {
        attempt: policy.attempts,
        ...(reason === undefined ? {} : { reason }),
        ...(code === undefined ? {} : { code }),
      }
      setState('failed', detail)
      emitDiagnostic(diagnostics, {
        kind: phase === 'connect' ? 'connect_failed' : 'reconnect_failed',
        ...scope,
        attempt: policy.attempts,
        durationMs,
        ...(reason === undefined ? {} : { reason }),
        ...(code === undefined ? {} : { code }),
      })
      return state
    } finally {
      if (myGeneration === generation) sequenceRunning = false
    }
  }

  /** `startedAt` defaults to now; a reconnect passes the time of the drop so durations cover it. */
  const startSequence = (
    phase: SequencePhase,
    startedAt: number = clock.now(),
  ): Promise<LiveKitConnectionState> => {
    settledPromise = runSequence(phase, startedAt)
    return settledPromise
  }

  const cancelSequence = (): void => {
    generation += 1
    sequenceRunning = false
    pendingDelay?.cancel()
    pendingDelay = null
  }

  room.on(LIVEKIT_ROOM_EVENTS.reconnecting, () => {
    if (sequenceRunning || intentional) return
    if (droppedAt === null) droppedAt = clock.now()
    sdkReconnectAttempts += 1
    setState('reconnecting', { attempt: sdkReconnectAttempts })
    emitDiagnostic(diagnostics, { kind: 'reconnecting', ...scope, attempt: sdkReconnectAttempts })
  })

  room.on(LIVEKIT_ROOM_EVENTS.reconnected, () => {
    if (sequenceRunning || intentional) return
    const durationMs = droppedAt === null ? 0 : clock.now() - droppedAt
    const attempt = sdkReconnectAttempts
    droppedAt = null
    sdkReconnectAttempts = 0
    setState('connected', { attempt })
    emitDiagnostic(diagnostics, { kind: 'connected', ...scope, attempt, durationMs })
  })

  room.on(LIVEKIT_ROOM_EVENTS.disconnected, (reason?: unknown) => {
    if (sequenceRunning) return
    if (intentional || state === 'disconnected' || state === 'failed') return
    const code = disconnectReasonName(reason)
    // The SDK may have been reconnecting on its own since the drop; count that time too.
    const dropStartedAt = droppedAt ?? clock.now()
    droppedAt = null
    sdkReconnectAttempts = 0
    if (isRetryableDisconnect(reason)) {
      void startSequence('reconnect', dropStartedAt)
      return
    }
    setState('disconnected', code === undefined ? {} : { code })
    emitDiagnostic(diagnostics, {
      kind: 'disconnected',
      ...scope,
      ...(code === undefined ? {} : { code }),
    })
  })

  room.on(LIVEKIT_ROOM_EVENTS.connectionQualityChanged, (quality, participant) => {
    options.onQuality?.(toQuality(quality), participant.identity)
  })

  room.on(LIVEKIT_ROOM_EVENTS.trackSubscriptionFailed, (trackSid, participant, reason) => {
    const code =
      subscriptionErrorName(reason) ?? (typeof reason === 'number' ? String(reason) : undefined)
    emitDiagnostic(diagnostics, {
      kind: 'track_subscribe_failed',
      ...scope,
      reason: `${trackSid} from ${participant.identity}`,
      ...(code === undefined ? {} : { code }),
    })
  })

  room.on(LIVEKIT_ROOM_EVENTS.mediaDevicesError, (error, kind) => {
    const reason = errorReason(error)
    if (isPermissionDeniedError(error)) {
      const permission = permissionFor(kind)
      emitDiagnostic(diagnostics, {
        kind: 'media_permission_denied',
        ...scope,
        reason,
        ...(permission === undefined ? {} : { permission }),
      })
      return
    }
    const source = sourceFor(kind)
    emitDiagnostic(diagnostics, {
      kind: 'media_device_error',
      ...scope,
      reason,
      ...(source === undefined ? {} : { source }),
    })
  })

  const toggle = async (
    source: RtcMediaPermission,
    action: () => Promise<unknown>,
  ): Promise<MediaToggleResult> => {
    try {
      await action()
      return { ok: true }
    } catch (error) {
      const reason = errorReason(error)
      if (isPermissionDeniedError(error)) {
        emitDiagnostic(diagnostics, {
          kind: 'media_permission_denied',
          ...scope,
          permission: source,
          reason,
        })
        return { ok: false, kind: 'media_permission_denied', error }
      }
      emitDiagnostic(diagnostics, { kind: 'track_publish_failed', ...scope, source, reason })
      return { ok: false, kind: 'track_publish_failed', error }
    }
  }

  void startSequence('connect')

  const flipCamera = options.flipCamera
  const connection: LiveKitConnection = {
    room,
    state: () => state,
    settled: () => settledPromise,
    async disconnect() {
      intentional = true
      cancelSequence()
      try {
        await room.disconnect()
      } catch {
        // The SDK could not close cleanly; the state is still "left" from Earth's point of view.
      }
      if (state !== 'disconnected') {
        setState('disconnected', { code: 'CLIENT_INITIATED' })
        emitDiagnostic(diagnostics, { kind: 'disconnected', ...scope, code: 'CLIENT_INITIATED' })
      }
    },
    retry() {
      if (state !== 'failed' && state !== 'disconnected') return settledPromise
      intentional = false
      cancelSequence()
      return startSequence('connect')
    },
    setMicrophoneEnabled: (enabled) =>
      toggle('microphone', () => room.localParticipant.setMicrophoneEnabled(enabled)),
    setCameraEnabled: (enabled) =>
      toggle('camera', () => room.localParticipant.setCameraEnabled(enabled)),
    ...(flipCamera === undefined ? {} : { flipCamera: () => flipCamera(room) }),
  }
  return connection
}
