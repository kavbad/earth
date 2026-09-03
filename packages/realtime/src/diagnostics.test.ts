import { asConversationId, asRoomId } from '@earth/domain'
import {
  REALTIME_CHANNEL_KINDS as OBSERVABILITY_CHANNEL_KINDS,
  RTC_DIAGNOSTIC_KINDS as OBSERVABILITY_DIAGNOSTIC_KINDS,
  RTC_MEDIA_PERMISSIONS as OBSERVABILITY_MEDIA_PERMISSIONS,
  RTC_TRACK_SOURCES as OBSERVABILITY_TRACK_SOURCES,
  type RtcDiagnosticEvent,
  createLogger,
  createMemorySink,
  createRecordingMonitor,
  createRtcDiagnostics,
  parseRtcDiagnosticEvent,
  rtcLogMessage,
} from '@earth/observability'
import { describe, expect, it, vi } from 'vitest'

import {
  REALTIME_CHANNEL_KINDS,
  RTC_DIAGNOSTIC_KINDS,
  RTC_MEDIA_PERMISSIONS,
  RTC_TRACK_SOURCES,
  type RealtimeDiagnosticEvent,
  type RealtimeDiagnostics,
  emitDiagnostic,
  noopDiagnostics,
} from './diagnostics'

const CONVERSATION_ID = asConversationId('11111111-1111-4111-8111-111111111111')
const ROOM_ID = asRoomId('22222222-2222-4222-8222-222222222222')

/**
 * One representative of every event shape this package emits (conversation, room, presence,
 * LiveKit and outbox). The observability parser is the server-side gate for the diagnostics
 * sink, so each must round-trip through it unchanged — a field or kind that only existed in a
 * local mirror would be dropped or rejected there.
 */
const EMITTED_EVENTS: readonly RtcDiagnosticEvent[] = [
  {
    kind: 'realtime_fallback',
    channel: 'conversation',
    conversationId: CONVERSATION_ID,
    attempt: 1,
    reason: 'join_timeout',
    code: 'join_timeout',
  },
  { kind: 'realtime_recovered', channel: 'room', roomId: ROOM_ID },
  {
    kind: 'realtime_poll_failed',
    channel: 'presence',
    attempt: 1,
    reason: 'offline',
  },
  { kind: 'connect_attempt', attempt: 1 },
  { kind: 'connected', attempt: 1, durationMs: 120.5 },
  { kind: 'connect_failed', attempt: 3, reason: 'server unreachable' },
  { kind: 'reconnecting', attempt: 2 },
  { kind: 'reconnect_failed', attempt: 5, reason: 'SIGNAL_CLOSE' },
  { kind: 'disconnected', reason: 'CLIENT_INITIATED' },
  { kind: 'network_unavailable', attempt: 1 },
  { kind: 'media_permission_denied', permission: 'camera', reason: 'NotAllowedError' },
  { kind: 'media_device_error', source: 'microphone', reason: 'device busy' },
  { kind: 'track_publish_failed', source: 'camera', reason: 'publish timed out' },
  { kind: 'track_subscribe_failed', source: 'screen_share', reason: 'SE_TRACK_NOTFOUND' },
  { kind: 'message_send_failed', attempt: 3, reason: 'rate_limited', code: 'rate_limited' },
]

describe('diagnostics contract (owned by @earth/observability)', () => {
  it('re-exports the observability literals rather than mirroring them', () => {
    expect(REALTIME_CHANNEL_KINDS).toBe(OBSERVABILITY_CHANNEL_KINDS)
    expect(RTC_DIAGNOSTIC_KINDS).toBe(OBSERVABILITY_DIAGNOSTIC_KINDS)
    expect(RTC_MEDIA_PERMISSIONS).toBe(OBSERVABILITY_MEDIA_PERMISSIONS)
    expect(RTC_TRACK_SOURCES).toBe(OBSERVABILITY_TRACK_SOURCES)
  })

  it('every event shape this package emits round-trips through the sink parser', () => {
    for (const event of EMITTED_EVENTS) {
      expect(parseRtcDiagnosticEvent(event), event.kind).toEqual(event)
    }
    const kinds = new Set(EMITTED_EVENTS.map((event) => event.kind))
    // The two kinds this package does not emit belong to the token route and the server tier.
    for (const kind of RTC_DIAGNOSTIC_KINDS) {
      if (kind === 'token_error' || kind === 'webhook_out_of_order') continue
      expect(kinds.has(kind), kind).toBe(true)
    }
  })

  it('accepts createRtcDiagnostics as the injected emitter', () => {
    const sink = createMemorySink()
    const recorder = createRecordingMonitor()
    const diagnostics: RealtimeDiagnostics = createRtcDiagnostics({
      monitor: recorder.monitor,
      logger: createLogger({ sink: sink.sink, level: 'debug' }),
    })
    const event: RealtimeDiagnosticEvent = {
      kind: 'realtime_fallback',
      channel: 'conversation',
      reason: 'join_timeout',
    }
    emitDiagnostic(diagnostics, event)
    expect(sink.records.map((record) => record.msg)).toContain(rtcLogMessage('realtime_fallback'))
    expect(recorder.calls).toContainEqual({
      method: 'addBreadcrumb',
      crumb: expect.objectContaining({ message: rtcLogMessage('realtime_fallback') }),
    })
  })
})

describe('emitDiagnostic', () => {
  it('never lets the emitter break the caller', async () => {
    const throwing: RealtimeDiagnostics = {
      emit: () => {
        throw new Error('sink down')
      },
    }
    const rejecting: RealtimeDiagnostics = { emit: () => Promise.reject(new Error('sink down')) }
    expect(() => emitDiagnostic(throwing, { kind: 'connected' })).not.toThrow()
    expect(() => emitDiagnostic(rejecting, { kind: 'connected' })).not.toThrow()
    expect(() => emitDiagnostic(noopDiagnostics, { kind: 'connected' })).not.toThrow()
    await Promise.resolve()
  })

  it('forwards the event', () => {
    const emit = vi.fn()
    emitDiagnostic({ emit }, { kind: 'realtime_fallback', channel: 'room' })
    expect(emit).toHaveBeenCalledWith({ kind: 'realtime_fallback', channel: 'room' })
  })
})
