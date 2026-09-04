/**
 * RTC connection diagnostics (spec §14: "every realtime/video failure must emit diagnostic
 * data"; spec PART XX failure states; ARCHITECTURE §8 realtime fallback and LiveKit connection
 * states, §6 `POST /api/diagnostics/rtc`).
 *
 * `@earth/realtime` emits an `RtcDiagnosticEvent` on every LiveKit connection transition, token
 * failure, media permission/device problem, track failure, Supabase Realtime fallback/recovery,
 * polling failure and failed message send; the server tier emits `webhook_out_of_order` when
 * LiveKit webhooks arrive out of sequence. `createRtcDiagnostics` turns each event into three
 * things at once: a structured log line, an error-monitor breadcrumb (plus a captured message for
 * failure kinds), and a POST to the first-party diagnostics sink so connection quality is
 * measurable without depending on a vendor. Free-text `reason`s are scrubbed of secrets before
 * they leave the process.
 *
 * `parseRtcDiagnosticEvent` / `parseRtcDiagnosticEnvelope` are the server-side validators for
 * the sink route; they accept only known kinds and fields and drop everything else.
 */
import {
  type ConversationId,
  type MediaIdentity,
  type RoomId,
  isUuid,
  parseMediaIdentity,
} from '@earth/domain'

import { type LogFields, type Logger } from './logger'
import {
  type BreadcrumbCategory,
  type ErrorMonitor,
  type MonitorSeverity,
  type MonitorTagValue,
  MONITOR_SEVERITY_LOG_LEVEL,
} from './monitor'
import { redactString } from './redact'

/**
 * Every diagnostic kind, grouped by the failure surface it covers:
 *
 * - LiveKit connection lifecycle — ARCHITECTURE §8 states `connecting | connected | reconnecting
 *   | failed` (`failed` is `connect_failed` on the first attempt and `reconnect_failed` after a
 *   drop, spec §109 "Couldn't reconnect") plus a clean `disconnected`.
 * - Preconditions — `network_unavailable` (spec §107: Live requires network) and `token_error`
 *   (`POST /api/rooms/:id/token`, spec §105).
 * - Local media — permission denied (screens 15/17), device failure, publish/subscribe failure.
 * - Supabase Realtime — channel fallback to polling, recovery, and the polling request failing
 *   (ARCHITECTURE §8).
 * - Messaging — `message_send_failed` (spec §108 failed optimistic message).
 * - Server tier — LiveKit webhooks arriving out of order (ARCHITECTURE §6).
 */
export const RTC_DIAGNOSTIC_KINDS = [
  'connect_attempt',
  'connected',
  'connect_failed',
  'reconnecting',
  'reconnect_failed',
  'disconnected',
  'network_unavailable',
  'token_error',
  'media_permission_denied',
  'media_device_error',
  'track_publish_failed',
  'track_subscribe_failed',
  'realtime_fallback',
  'realtime_recovered',
  'realtime_poll_failed',
  'message_send_failed',
  'webhook_out_of_order',
] as const
export type RtcDiagnosticKind = (typeof RTC_DIAGNOSTIC_KINDS)[number]

/** Supabase Realtime channels that can fall back to polling (ARCHITECTURE §8). */
export const REALTIME_CHANNEL_KINDS = ['conversation', 'room', 'presence'] as const
export type RealtimeChannelKind = (typeof REALTIME_CHANNEL_KINDS)[number]

/** Device permissions a room can be denied. */
export const RTC_MEDIA_PERMISSIONS = ['microphone', 'camera'] as const
export type RtcMediaPermission = (typeof RTC_MEDIA_PERMISSIONS)[number]

/** LiveKit track sources a participant publishes or subscribes to. */
export const RTC_TRACK_SOURCES = ['microphone', 'camera', 'screen_share'] as const
export type RtcTrackSource = (typeof RTC_TRACK_SOURCES)[number]

export interface RtcDiagnosticBase {
  readonly roomId?: RoomId
  readonly conversationId?: ConversationId
  /** LiveKit identity `h:<human_id>` / `g:<guest_session_id>` (ARCHITECTURE §10). */
  readonly participantIdentity?: MediaIdentity
  /** Attempt counter for connect/reconnect/retry sequences (1 for the first attempt). */
  readonly attempt?: number
  /** Time the transition took (for example connect latency, spec §129). */
  readonly durationMs?: number
  /** Free-text reason from the SDK or the app; never user content. Scrubbed of secrets. */
  readonly reason?: string
  /** Machine code from the SDK, the server (`EarthErrorCode`) or HTTP. */
  readonly code?: string
}

export interface RtcConnectAttemptEvent extends RtcDiagnosticBase {
  readonly kind: 'connect_attempt'
}
export interface RtcConnectedEvent extends RtcDiagnosticBase {
  readonly kind: 'connected'
}
/** The first connection never established (ARCHITECTURE §8 `failed` from `connecting`). */
export interface RtcConnectFailedEvent extends RtcDiagnosticBase {
  readonly kind: 'connect_failed'
}
export interface RtcReconnectingEvent extends RtcDiagnosticBase {
  readonly kind: 'reconnecting'
}
/** Automatic reconnect gave up: the "Couldn't reconnect" state of spec §109. */
export interface RtcReconnectFailedEvent extends RtcDiagnosticBase {
  readonly kind: 'reconnect_failed'
}
export interface RtcDisconnectedEvent extends RtcDiagnosticBase {
  readonly kind: 'disconnected'
}
/** Live was attempted or needed while the device reports no network (spec §107). */
export interface RtcNetworkUnavailableEvent extends RtcDiagnosticBase {
  readonly kind: 'network_unavailable'
}
export interface RtcTokenErrorEvent extends RtcDiagnosticBase {
  readonly kind: 'token_error'
  /** Status returned by `POST /api/rooms/:id/token` when the failure was HTTP-level. */
  readonly httpStatus?: number
}
export interface RtcMediaPermissionDeniedEvent extends RtcDiagnosticBase {
  readonly kind: 'media_permission_denied'
  readonly permission?: RtcMediaPermission
}
/** Permission was granted but the device could not be opened (busy, missing, unreadable). */
export interface RtcMediaDeviceErrorEvent extends RtcDiagnosticBase {
  readonly kind: 'media_device_error'
  readonly source?: RtcTrackSource
}
export interface RtcTrackPublishFailedEvent extends RtcDiagnosticBase {
  readonly kind: 'track_publish_failed'
  readonly source?: RtcTrackSource
}
/** A remote participant's track could not be subscribed (they are in the room but unseen/unheard). */
export interface RtcTrackSubscribeFailedEvent extends RtcDiagnosticBase {
  readonly kind: 'track_subscribe_failed'
  readonly source?: RtcTrackSource
}
export interface RtcRealtimeFallbackEvent extends RtcDiagnosticBase {
  readonly kind: 'realtime_fallback'
  readonly channel?: RealtimeChannelKind
}
export interface RtcRealtimeRecoveredEvent extends RtcDiagnosticBase {
  readonly kind: 'realtime_recovered'
  readonly channel?: RealtimeChannelKind
}
/** The polling fallback itself failed (`messages_since` / `room_state`), so nothing is flowing. */
export interface RtcRealtimePollFailedEvent extends RtcDiagnosticBase {
  readonly kind: 'realtime_poll_failed'
  readonly channel?: RealtimeChannelKind
}
/** An optimistic message could not be sent (spec §108); `attempt` counts idempotent resends. */
export interface RtcMessageSendFailedEvent extends RtcDiagnosticBase {
  readonly kind: 'message_send_failed'
}
export interface RtcWebhookOutOfOrderEvent extends RtcDiagnosticBase {
  readonly kind: 'webhook_out_of_order'
  /** LiveKit webhook event name (`participant_joined`, `room_finished`, ...). */
  readonly eventType?: string
  readonly eventId?: string
}

export type RtcDiagnosticEvent =
  | RtcConnectAttemptEvent
  | RtcConnectedEvent
  | RtcConnectFailedEvent
  | RtcReconnectingEvent
  | RtcReconnectFailedEvent
  | RtcDisconnectedEvent
  | RtcNetworkUnavailableEvent
  | RtcTokenErrorEvent
  | RtcMediaPermissionDeniedEvent
  | RtcMediaDeviceErrorEvent
  | RtcTrackPublishFailedEvent
  | RtcTrackSubscribeFailedEvent
  | RtcRealtimeFallbackEvent
  | RtcRealtimeRecoveredEvent
  | RtcRealtimePollFailedEvent
  | RtcMessageSendFailedEvent
  | RtcWebhookOutOfOrderEvent

/** Severity of each kind; `error` kinds are also captured as monitor messages. */
export const RTC_DIAGNOSTIC_SEVERITY: Readonly<Record<RtcDiagnosticKind, MonitorSeverity>> = {
  connect_attempt: 'info',
  connected: 'info',
  connect_failed: 'error',
  reconnecting: 'warning',
  reconnect_failed: 'error',
  disconnected: 'info',
  network_unavailable: 'warning',
  token_error: 'error',
  media_permission_denied: 'warning',
  media_device_error: 'error',
  track_publish_failed: 'error',
  track_subscribe_failed: 'error',
  realtime_fallback: 'warning',
  realtime_recovered: 'info',
  realtime_poll_failed: 'error',
  message_send_failed: 'error',
  webhook_out_of_order: 'warning',
}

const FAILURE_SEVERITY: MonitorSeverity = 'error'

/** True for kinds that represent a failure the user experienced (spec PART XX). */
export function isRtcFailureKind(kind: RtcDiagnosticKind): boolean {
  return RTC_DIAGNOSTIC_SEVERITY[kind] === FAILURE_SEVERITY
}

// ---------------------------------------------------------------------------------------------
// LiveKit connection states (ARCHITECTURE §8)
// ---------------------------------------------------------------------------------------------

/** Reconnect states of `connectRoom` in `@earth/realtime`; every transition emits a diagnostic. */
export const RTC_CONNECTION_STATES = ['connecting', 'connected', 'reconnecting', 'failed'] as const
export type RtcConnectionState = (typeof RTC_CONNECTION_STATES)[number]

/**
 * The diagnostic kind to emit when the connection enters `state`. `failed` reached from the
 * initial `connecting` is `connect_failed`; reached after a drop it is `reconnect_failed`
 * (spec §109 "Couldn't reconnect").
 */
export function diagnosticKindForConnectionState(
  state: RtcConnectionState,
  previous?: RtcConnectionState,
): RtcDiagnosticKind {
  switch (state) {
    case 'connecting':
      return 'connect_attempt'
    case 'connected':
      return 'connected'
    case 'reconnecting':
      return 'reconnecting'
    case 'failed':
      return previous === undefined || previous === 'connecting'
        ? 'connect_failed'
        : 'reconnect_failed'
  }
}

// ---------------------------------------------------------------------------------------------
// Emitter
// ---------------------------------------------------------------------------------------------

export const RTC_LOG_MESSAGE_PREFIX = 'rtc.' as const
export type RtcLogMessage = `${typeof RTC_LOG_MESSAGE_PREFIX}${RtcDiagnosticKind}`

export function rtcLogMessage(kind: RtcDiagnosticKind): RtcLogMessage {
  return `${RTC_LOG_MESSAGE_PREFIX}${kind}`
}

/** Logged (at `warn`) when the diagnostics sink rejects; the emit itself never fails. */
export const RTC_SINK_FAILED_MESSAGE = 'rtc.sink_failed' as const

const RTC_BREADCRUMB_CATEGORY: BreadcrumbCategory = 'rtc'

/** Monitor tag keys attached to captured RTC failures. */
export const RTC_TAGS = { kind: 'rtc_kind', roomId: 'room_id' } as const

export interface RtcDiagnosticMeta {
  /** ISO-8601 time the event was emitted. */
  readonly ts: string
}

export type RtcDiagnosticSink = (
  event: RtcDiagnosticEvent,
  meta: RtcDiagnosticMeta,
) => Promise<void>

export interface RtcDiagnosticsOptions {
  readonly monitor: ErrorMonitor
  readonly logger: Logger
  /** Where events are posted (see `createHttpRtcSink`); omitted in tests and on the server. */
  readonly sink?: RtcDiagnosticSink
  /** Fields merged under every emitted event (for example the current `roomId`). */
  readonly defaults?: RtcDiagnosticBase
  /** Also `captureMessage` failure kinds on the monitor. Defaults to `true`. */
  readonly captureFailures?: boolean
  readonly now?: () => Date
}

export interface RtcDiagnostics {
  /** Logs, adds a breadcrumb and posts to the sink. Resolves after the sink; never rejects. */
  emit(event: RtcDiagnosticEvent): Promise<void>
  /** A diagnostics emitter whose events carry `defaults` unless the event overrides them. */
  scoped(defaults: RtcDiagnosticBase): RtcDiagnostics
}

/** Scrubs the free-text field so no secret-shaped SDK message reaches a log, monitor or sink. */
export function scrubRtcDiagnosticEvent(event: RtcDiagnosticEvent): RtcDiagnosticEvent {
  if (event.reason === undefined) return event
  const reason = redactString(event.reason)
  return reason === event.reason ? event : { ...event, reason }
}

/** Runs a monitoring side effect; an adapter that throws must never break the call site. */
function attempt(effect: () => void): void {
  try {
    effect()
  } catch {
    // Diagnostics are best effort; the remaining outputs still run.
  }
}

export function createRtcDiagnostics(options: RtcDiagnosticsOptions): RtcDiagnostics {
  const { monitor, logger, sink } = options
  const now = options.now ?? (() => new Date())
  const captureFailures = options.captureFailures ?? true

  const build = (defaults: RtcDiagnosticBase): RtcDiagnostics => ({
    async emit(input) {
      const event = scrubRtcDiagnosticEvent({ ...defaults, ...input })
      const severity = RTC_DIAGNOSTIC_SEVERITY[event.kind]
      const message = rtcLogMessage(event.kind)
      const at = now()
      const fields: LogFields = { ...event }

      attempt(() => logger[MONITOR_SEVERITY_LOG_LEVEL[severity]](message, fields))
      attempt(() =>
        monitor.addBreadcrumb({
          category: RTC_BREADCRUMB_CATEGORY,
          message,
          level: severity,
          data: fields,
          timestampMs: at.getTime(),
        }),
      )
      if (captureFailures && isRtcFailureKind(event.kind)) {
        const tags: Record<string, MonitorTagValue> = { [RTC_TAGS.kind]: event.kind }
        if (event.roomId !== undefined) tags[RTC_TAGS.roomId] = event.roomId
        attempt(() => monitor.captureMessage(message, severity, { tags, extra: fields }))
      }
      if (sink === undefined) return
      try {
        await sink(event, { ts: at.toISOString() })
      } catch (error) {
        attempt(() => logger.warn(RTC_SINK_FAILED_MESSAGE, { kind: event.kind, error }))
      }
    },
    scoped: (more) => build({ ...defaults, ...more }),
  })

  return build(options.defaults ?? {})
}

// ---------------------------------------------------------------------------------------------
// HTTP sink → POST /api/diagnostics/rtc
// ---------------------------------------------------------------------------------------------

export const RTC_DIAGNOSTICS_PATH = '/api/diagnostics/rtc' as const
export const RTC_DIAGNOSTIC_ENVELOPE_VERSION = 1 as const

/** Wire format accepted by `POST /api/diagnostics/rtc`. */
export interface RtcDiagnosticEnvelope {
  readonly v: typeof RTC_DIAGNOSTIC_ENVELOPE_VERSION
  readonly ts: string
  readonly event: RtcDiagnosticEvent
}

export interface FetchLikeInit {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: string
  readonly keepalive?: boolean
}

export interface FetchLikeResponse {
  readonly ok: boolean
  readonly status: number
}

/** The slice of `fetch` the sink uses; the global `fetch` (web, Node, React Native) satisfies it. */
export type FetchLike = (input: string, init?: FetchLikeInit) => Promise<FetchLikeResponse>

export interface HttpRtcSinkOptions {
  /** `API_BASE_URL` from `@earth/config`; a trailing slash is tolerated. */
  readonly apiBaseUrl: string
  readonly fetch: FetchLike
  /** Supabase access token of the caller, or `null` for Visitors (guest sessions do have one). */
  readonly getAccessToken: () => Promise<string | null | undefined> | string | null | undefined
}

const HTTP_METHOD_POST = 'POST' as const
const HEADER_CONTENT_TYPE = 'content-type' as const
const HEADER_AUTHORIZATION = 'authorization' as const
const JSON_CONTENT_TYPE = 'application/json' as const
const BEARER_PREFIX = 'Bearer ' as const

export class RtcSinkError extends Error {
  override readonly name = 'RtcSinkError' as const
  readonly status: number

  constructor(status: number) {
    super(`${RTC_DIAGNOSTICS_PATH} responded ${status}`)
    this.status = status
  }
}

export function rtcDiagnosticsUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}${RTC_DIAGNOSTICS_PATH}`
}

export function createHttpRtcSink(options: HttpRtcSinkOptions): RtcDiagnosticSink {
  const url = rtcDiagnosticsUrl(options.apiBaseUrl)
  // Copied into locals so `fetch` is invoked unbound: browsers throw "Illegal invocation" when
  // `window.fetch` is called with another `this`.
  const fetchImpl = options.fetch
  const getAccessToken = options.getAccessToken
  return async (event, meta) => {
    const token = await getAccessToken()
    const headers: Record<string, string> = { [HEADER_CONTENT_TYPE]: JSON_CONTENT_TYPE }
    if (typeof token === 'string' && token.length > 0) {
      headers[HEADER_AUTHORIZATION] = `${BEARER_PREFIX}${token}`
    }
    const envelope: RtcDiagnosticEnvelope = {
      v: RTC_DIAGNOSTIC_ENVELOPE_VERSION,
      ts: meta.ts,
      event: scrubRtcDiagnosticEvent(event),
    }
    const response = await fetchImpl(url, {
      method: HTTP_METHOD_POST,
      headers,
      body: JSON.stringify(envelope),
      keepalive: true,
    })
    if (!response.ok) throw new RtcSinkError(response.status)
  }
}

// ---------------------------------------------------------------------------------------------
// Server-side validation of incoming envelopes
// ---------------------------------------------------------------------------------------------

export const RTC_REASON_MAX_LENGTH = 500
export const RTC_CODE_MAX_LENGTH = 100
export const RTC_EVENT_ID_MAX_LENGTH = 200
export const RTC_EVENT_TYPE_MAX_LENGTH = 100
/** Valid range of `httpStatus` on `token_error`. */
export const RTC_HTTP_STATUS_MIN = 100
export const RTC_HTTP_STATUS_MAX = 599

const KIND_SET: ReadonlySet<string> = new Set<string>(RTC_DIAGNOSTIC_KINDS)
const CHANNEL_SET: ReadonlySet<string> = new Set<string>(REALTIME_CHANNEL_KINDS)
const PERMISSION_SET: ReadonlySet<string> = new Set<string>(RTC_MEDIA_PERMISSIONS)
const TRACK_SOURCE_SET: ReadonlySet<string> = new Set<string>(RTC_TRACK_SOURCES)

export function isRtcDiagnosticKind(value: unknown): value is RtcDiagnosticKind {
  return typeof value === 'string' && KIND_SET.has(value)
}

/** Marker returned by the optional-field validators when a present value is malformed. */
const INVALID = Symbol('invalid')
type Invalid = typeof INVALID

function optionalString(value: unknown, maxLength: number): string | undefined | Invalid {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return INVALID
  return value
}

/** A finite, non-negative number (durations may be fractional milliseconds). */
function optionalDuration(value: unknown): number | undefined | Invalid {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return INVALID
  return value
}

/** An integer within `[min, max]`. */
function optionalInteger(
  value: unknown,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER,
): number | undefined | Invalid {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    return INVALID
  }
  return value
}

function optionalMember<T extends string>(
  value: unknown,
  members: ReadonlySet<string>,
): T | undefined | Invalid {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !members.has(value)) return INVALID
  return value as T
}

interface MutableRtcDiagnosticBase {
  roomId?: RoomId
  conversationId?: ConversationId
  participantIdentity?: MediaIdentity
  attempt?: number
  durationMs?: number
  reason?: string
  code?: string
}

function parseBase(record: Record<string, unknown>): RtcDiagnosticBase | null {
  const base: MutableRtcDiagnosticBase = {}

  if (record.roomId !== undefined) {
    if (!isUuid(record.roomId)) return null
    base.roomId = record.roomId as RoomId
  }
  if (record.conversationId !== undefined) {
    if (!isUuid(record.conversationId)) return null
    base.conversationId = record.conversationId as ConversationId
  }
  if (record.participantIdentity !== undefined) {
    const identity = record.participantIdentity
    if (typeof identity !== 'string' || parseMediaIdentity(identity) === null) return null
    base.participantIdentity = identity as MediaIdentity
  }

  const attempt = optionalInteger(record.attempt, 0)
  if (attempt === INVALID) return null
  if (attempt !== undefined) base.attempt = attempt

  const durationMs = optionalDuration(record.durationMs)
  if (durationMs === INVALID) return null
  if (durationMs !== undefined) base.durationMs = durationMs

  const reason = optionalString(record.reason, RTC_REASON_MAX_LENGTH)
  if (reason === INVALID) return null
  if (reason !== undefined) base.reason = redactString(reason)

  const code = optionalString(record.code, RTC_CODE_MAX_LENGTH)
  if (code === INVALID) return null
  if (code !== undefined) base.code = code

  return base
}

/**
 * Validates an untrusted value as an `RtcDiagnosticEvent`. Unknown keys are dropped, malformed
 * known fields reject the whole event (`null`), so the server stores only well-formed data.
 */
export function parseRtcDiagnosticEvent(value: unknown): RtcDiagnosticEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const kind = record.kind
  if (!isRtcDiagnosticKind(kind)) return null
  const base = parseBase(record)
  if (base === null) return null

  switch (kind) {
    case 'connect_attempt':
    case 'connected':
    case 'connect_failed':
    case 'reconnecting':
    case 'reconnect_failed':
    case 'disconnected':
    case 'network_unavailable':
    case 'message_send_failed':
      return { kind, ...base }
    case 'token_error': {
      const httpStatus = optionalInteger(
        record.httpStatus,
        RTC_HTTP_STATUS_MIN,
        RTC_HTTP_STATUS_MAX,
      )
      if (httpStatus === INVALID) return null
      return httpStatus === undefined ? { kind, ...base } : { kind, ...base, httpStatus }
    }
    case 'media_permission_denied': {
      const permission = optionalMember<RtcMediaPermission>(record.permission, PERMISSION_SET)
      if (permission === INVALID) return null
      return permission === undefined ? { kind, ...base } : { kind, ...base, permission }
    }
    case 'media_device_error':
    case 'track_publish_failed':
    case 'track_subscribe_failed': {
      const source = optionalMember<RtcTrackSource>(record.source, TRACK_SOURCE_SET)
      if (source === INVALID) return null
      return source === undefined ? { kind, ...base } : { kind, ...base, source }
    }
    case 'realtime_fallback':
    case 'realtime_recovered':
    case 'realtime_poll_failed': {
      const channel = optionalMember<RealtimeChannelKind>(record.channel, CHANNEL_SET)
      if (channel === INVALID) return null
      return channel === undefined ? { kind, ...base } : { kind, ...base, channel }
    }
    case 'webhook_out_of_order': {
      const eventType = optionalString(record.eventType, RTC_EVENT_TYPE_MAX_LENGTH)
      if (eventType === INVALID) return null
      const eventId = optionalString(record.eventId, RTC_EVENT_ID_MAX_LENGTH)
      if (eventId === INVALID) return null
      const event: {
        kind: typeof kind
        eventType?: string
        eventId?: string
      } & RtcDiagnosticBase = { kind, ...base }
      if (eventType !== undefined) event.eventType = eventType
      if (eventId !== undefined) event.eventId = eventId
      return event
    }
  }
}

/** Validates the wire envelope posted to `/api/diagnostics/rtc`. */
export function parseRtcDiagnosticEnvelope(value: unknown): RtcDiagnosticEnvelope | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.v !== RTC_DIAGNOSTIC_ENVELOPE_VERSION) return null
  if (typeof record.ts !== 'string' || Number.isNaN(Date.parse(record.ts))) return null
  const event = parseRtcDiagnosticEvent(record.event)
  if (event === null) return null
  return { v: RTC_DIAGNOSTIC_ENVELOPE_VERSION, ts: record.ts, event }
}
