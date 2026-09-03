import { asConversationId, asHumanId, asRoomId, mediaIdentityForHuman } from '@earth/domain'
import { describe, expect, it, vi } from 'vitest'

import { createLogger, createMemorySink } from './logger'
import {
  type ErrorMonitor,
  type MonitorSeverity,
  MONITOR_SEVERITY_LOG_LEVEL,
  createRecordingMonitor,
} from './monitor'
import {
  RTC_CONNECTION_STATES,
  RTC_DIAGNOSTICS_PATH,
  RTC_DIAGNOSTIC_ENVELOPE_VERSION,
  RTC_DIAGNOSTIC_KINDS,
  RTC_DIAGNOSTIC_SEVERITY,
  RTC_HTTP_STATUS_MAX,
  RTC_SINK_FAILED_MESSAGE,
  RTC_TAGS,
  type FetchLike,
  type FetchLikeInit,
  type RtcConnectionState,
  type RtcDiagnosticEvent,
  type RtcDiagnosticKind,
  type RtcDiagnosticSink,
  RtcSinkError,
  createHttpRtcSink,
  createRtcDiagnostics,
  diagnosticKindForConnectionState,
  isRtcFailureKind,
  parseRtcDiagnosticEnvelope,
  parseRtcDiagnosticEvent,
  rtcDiagnosticsUrl,
  rtcLogMessage,
  scrubRtcDiagnosticEvent,
} from './rtc'

const ROOM_ID = asRoomId('11111111-1111-4111-8111-111111111111')
const CONVERSATION_ID = asConversationId('22222222-2222-4222-8222-222222222222')
const IDENTITY = mediaIdentityForHuman(asHumanId('33333333-3333-4333-8333-333333333333'))
const FIXED_TS = '2026-09-03T12:00:00.000Z'
const now = (): Date => new Date(FIXED_TS)

function setup(options: { sink?: RtcDiagnosticSink; captureFailures?: boolean } = {}) {
  const memory = createMemorySink()
  const logger = createLogger({ sink: memory.sink, level: 'debug', now })
  const recording = createRecordingMonitor()
  const diagnostics = createRtcDiagnostics({
    monitor: recording.monitor,
    logger,
    now,
    ...(options.sink === undefined ? {} : { sink: options.sink }),
    ...(options.captureFailures === undefined ? {} : { captureFailures: options.captureFailures }),
  })
  return { memory, recording, diagnostics }
}

describe('RTC_DIAGNOSTIC_KINDS', () => {
  /**
   * Every realtime/video failure named by spec §14, §105, PART XX (§107–§109) and ARCHITECTURE
   * §6/§8 has a kind, and every kind has a spec anchor.
   */
  const COVERAGE: Array<[anchor: string, kind: RtcDiagnosticKind, severity: MonitorSeverity]> = [
    ['ARCHITECTURE §8 LiveKit state connecting', 'connect_attempt', 'info'],
    ['ARCHITECTURE §8 LiveKit state connected', 'connected', 'info'],
    ['ARCHITECTURE §8 LiveKit state failed on the first attempt', 'connect_failed', 'error'],
    ['ARCHITECTURE §8 reconnecting / spec §109 "Reconnecting…"', 'reconnecting', 'warning'],
    [
      'ARCHITECTURE §8 failed after a drop / spec §109 "Couldn\'t reconnect"',
      'reconnect_failed',
      'error',
    ],
    ['clean leave', 'disconnected', 'info'],
    ['spec §107 Live requires network', 'network_unavailable', 'warning'],
    ['spec §105 room token issuance (POST /api/rooms/:id/token)', 'token_error', 'error'],
    ['screens 15/17 camera and microphone permission', 'media_permission_denied', 'warning'],
    ['camera / microphone device failure', 'media_device_error', 'error'],
    ['local track publish failure', 'track_publish_failed', 'error'],
    ['remote track subscribe failure', 'track_subscribe_failed', 'error'],
    ['ARCHITECTURE §8 channel join timeout or error → polling', 'realtime_fallback', 'warning'],
    ['ARCHITECTURE §8 channel recovered from polling', 'realtime_recovered', 'info'],
    ['ARCHITECTURE §8 polling fallback request failed', 'realtime_poll_failed', 'error'],
    ['spec §108 failed optimistic message', 'message_send_failed', 'error'],
    ['ARCHITECTURE §6 LiveKit webhook out of order', 'webhook_out_of_order', 'warning'],
  ]

  it.each(COVERAGE)('%s → %s at %s', (_anchor, kind, severity) => {
    expect(RTC_DIAGNOSTIC_KINDS).toContain(kind)
    expect(RTC_DIAGNOSTIC_SEVERITY[kind]).toBe(severity)
  })

  it('anchors every kind to the spec exactly once', () => {
    expect([...COVERAGE.map(([, kind]) => kind)].sort()).toEqual([...RTC_DIAGNOSTIC_KINDS].sort())
    expect(new Set(RTC_DIAGNOSTIC_KINDS).size).toBe(RTC_DIAGNOSTIC_KINDS.length)
  })

  it('classifies failure kinds', () => {
    expect(RTC_DIAGNOSTIC_KINDS.filter(isRtcFailureKind)).toEqual([
      'connect_failed',
      'reconnect_failed',
      'token_error',
      'media_device_error',
      'track_publish_failed',
      'track_subscribe_failed',
      'realtime_poll_failed',
      'message_send_failed',
    ])
  })

  it('maps every connection state to a kind, telling first-connect failure from reconnect failure', () => {
    const states: readonly RtcConnectionState[] = RTC_CONNECTION_STATES
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'failed'])
    for (const state of RTC_CONNECTION_STATES) {
      expect(RTC_DIAGNOSTIC_KINDS).toContain(diagnosticKindForConnectionState(state))
    }
    expect(diagnosticKindForConnectionState('connecting')).toBe('connect_attempt')
    expect(diagnosticKindForConnectionState('connected', 'connecting')).toBe('connected')
    expect(diagnosticKindForConnectionState('reconnecting', 'connected')).toBe('reconnecting')
    expect(diagnosticKindForConnectionState('failed')).toBe('connect_failed')
    expect(diagnosticKindForConnectionState('failed', 'connecting')).toBe('connect_failed')
    expect(diagnosticKindForConnectionState('failed', 'reconnecting')).toBe('reconnect_failed')
    expect(diagnosticKindForConnectionState('failed', 'connected')).toBe('reconnect_failed')
  })
})

describe('createRtcDiagnostics', () => {
  it('logs, adds a breadcrumb and posts the event to the sink', async () => {
    const sink = vi.fn<RtcDiagnosticSink>(() => Promise.resolve())
    const { memory, recording, diagnostics } = setup({ sink })
    const event: RtcDiagnosticEvent = {
      kind: 'connected',
      roomId: ROOM_ID,
      participantIdentity: IDENTITY,
      attempt: 1,
      durationMs: 420,
    }

    await diagnostics.emit(event)

    expect(memory.records).toHaveLength(1)
    expect(memory.records[0]).toMatchObject({
      level: 'info',
      msg: rtcLogMessage('connected'),
      fields: event,
    })
    expect(recording.calls).toEqual([
      {
        method: 'addBreadcrumb',
        crumb: {
          category: 'rtc',
          message: 'rtc.connected',
          level: 'info',
          data: event,
          timestampMs: new Date(FIXED_TS).getTime(),
        },
      },
    ])
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledWith(event, { ts: FIXED_TS })
  })

  it.each(RTC_DIAGNOSTIC_KINDS)('logs %s at the level of its severity', async (kind) => {
    const { memory, diagnostics } = setup()
    await diagnostics.emit({ kind })
    expect(memory.records[0]?.level).toBe(MONITOR_SEVERITY_LOG_LEVEL[RTC_DIAGNOSTIC_SEVERITY[kind]])
    expect(memory.records[0]?.msg).toBe(`rtc.${kind}`)
  })

  it('captures failure kinds as monitor messages tagged with the kind and room', async () => {
    const { recording, diagnostics } = setup()
    await diagnostics.emit({
      kind: 'reconnect_failed',
      roomId: ROOM_ID,
      attempt: 3,
      reason: 'timeout',
    })
    const captured = recording.calls.find((call) => call.method === 'captureMessage')
    expect(captured).toEqual({
      method: 'captureMessage',
      message: 'rtc.reconnect_failed',
      level: 'error',
      context: {
        tags: { [RTC_TAGS.kind]: 'reconnect_failed', [RTC_TAGS.roomId]: ROOM_ID },
        extra: { kind: 'reconnect_failed', roomId: ROOM_ID, attempt: 3, reason: 'timeout' },
      },
    })
  })

  it('does not capture non-failure kinds, and honours captureFailures: false', async () => {
    const plain = setup()
    await plain.diagnostics.emit({ kind: 'reconnecting', attempt: 1 })
    expect(plain.recording.calls.map((call) => call.method)).toEqual(['addBreadcrumb'])

    const silent = setup({ captureFailures: false })
    await silent.diagnostics.emit({ kind: 'token_error', code: 'not_in_room' })
    expect(silent.recording.calls.map((call) => call.method)).toEqual(['addBreadcrumb'])
  })

  it('never rejects when the sink fails; it warns instead', async () => {
    const failure = new Error('offline')
    const { memory, diagnostics } = setup({ sink: () => Promise.reject(failure) })
    await expect(diagnostics.emit({ kind: 'disconnected' })).resolves.toBeUndefined()
    expect(memory.records.map((record) => [record.level, record.msg])).toEqual([
      ['info', 'rtc.disconnected'],
      ['warn', RTC_SINK_FAILED_MESSAGE],
    ])
    expect(memory.records[1]?.fields).toMatchObject({
      kind: 'disconnected',
      error: { name: 'Error', message: 'offline' },
    })
  })

  it('never rejects when the monitor throws; the log line and the sink still happen', async () => {
    const sink = vi.fn<RtcDiagnosticSink>(() => Promise.resolve())
    const memory = createMemorySink()
    const logger = createLogger({ sink: memory.sink, level: 'debug', now })
    const broken: ErrorMonitor = {
      captureException: () => undefined,
      captureMessage: () => {
        throw new Error('adapter down')
      },
      setUser: () => undefined,
      setRelease: () => undefined,
      addBreadcrumb: () => {
        throw new Error('adapter down')
      },
    }
    const diagnostics = createRtcDiagnostics({ monitor: broken, logger, sink, now })

    await expect(
      diagnostics.emit({ kind: 'token_error', httpStatus: 401 }),
    ).resolves.toBeUndefined()

    expect(memory.records.map((record) => record.msg)).toEqual(['rtc.token_error'])
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it('scrubs secrets out of reason before logging, breadcrumbs, capture and the sink', async () => {
    const sink = vi.fn<RtcDiagnosticSink>(() => Promise.resolve())
    const { memory, recording, diagnostics } = setup({ sink })
    const secret = 'abc.def'

    await diagnostics.emit({
      kind: 'connect_failed',
      reason: `signal wss://lk/rtc?access_token=${secret} failed`,
    })

    const scrubbed = 'signal wss://lk/rtc?access_token=[REDACTED] failed'
    expect(memory.records[0]?.fields).toMatchObject({ reason: scrubbed })
    expect(sink).toHaveBeenCalledWith(
      { kind: 'connect_failed', reason: scrubbed },
      { ts: FIXED_TS },
    )
    expect(JSON.stringify(recording.calls)).not.toContain(secret)
    expect(JSON.stringify(memory.lines)).not.toContain(secret)
  })

  it('returns the same event object when the reason is clean', () => {
    const event: RtcDiagnosticEvent = { kind: 'connected', reason: 'ok' }
    expect(scrubRtcDiagnosticEvent(event)).toBe(event)
    expect(scrubRtcDiagnosticEvent({ kind: 'connected' })).toEqual({ kind: 'connected' })
  })

  it('scoped emitters merge defaults under the event', async () => {
    const sink = vi.fn<RtcDiagnosticSink>(() => Promise.resolve())
    const { diagnostics } = setup({ sink })
    const scoped = diagnostics
      .scoped({ roomId: ROOM_ID, conversationId: CONVERSATION_ID })
      .scoped({ participantIdentity: IDENTITY })

    await scoped.emit({ kind: 'realtime_fallback', channel: 'room', reason: 'join_timeout' })
    await scoped.emit({ kind: 'connect_attempt', attempt: 2 })

    expect(sink.mock.calls[0]?.[0]).toEqual({
      kind: 'realtime_fallback',
      channel: 'room',
      reason: 'join_timeout',
      roomId: ROOM_ID,
      conversationId: CONVERSATION_ID,
      participantIdentity: IDENTITY,
    })
    expect(sink.mock.calls[1]?.[0]).toMatchObject({
      kind: 'connect_attempt',
      attempt: 2,
      roomId: ROOM_ID,
    })
  })
})

describe('createHttpRtcSink', () => {
  interface Call {
    url: string
    init: FetchLikeInit | undefined
  }

  function fakeFetch(status = 204): { fetch: FetchLike; calls: Call[] } {
    const calls: Call[] = []
    const fetch: FetchLike = (url, init) => {
      calls.push({ url, init })
      return Promise.resolve({ ok: status >= 200 && status < 300, status })
    }
    return { fetch, calls }
  }

  it('posts a versioned envelope with a bearer token to /api/diagnostics/rtc', async () => {
    const { fetch, calls } = fakeFetch()
    const sink = createHttpRtcSink({
      apiBaseUrl: 'https://earth.social/',
      fetch,
      getAccessToken: () => Promise.resolve('access-token'),
    })
    const event: RtcDiagnosticEvent = { kind: 'token_error', roomId: ROOM_ID, httpStatus: 403 }

    await sink(event, { ts: FIXED_TS })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`https://earth.social${RTC_DIAGNOSTICS_PATH}`)
    expect(calls[0]?.init).toEqual({
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer access-token' },
      body: JSON.stringify({ v: RTC_DIAGNOSTIC_ENVELOPE_VERSION, ts: FIXED_TS, event }),
      keepalive: true,
    })
  })

  it('scrubs the reason in the posted body even when called directly', async () => {
    const { fetch, calls } = fakeFetch()
    const sink = createHttpRtcSink({
      apiBaseUrl: 'http://localhost:3000',
      fetch,
      getAccessToken: () => null,
    })
    await sink({ kind: 'connect_failed', reason: 'ws closed: Bearer abc' }, { ts: FIXED_TS })
    expect(calls[0]?.init?.body).toContain('Bearer [REDACTED]')
    expect(calls[0]?.init?.body).not.toContain('Bearer abc')
  })

  it('omits the authorization header for visitors', async () => {
    const { fetch, calls } = fakeFetch()
    const sink = createHttpRtcSink({
      apiBaseUrl: 'http://localhost:3000',
      fetch,
      getAccessToken: () => null,
    })
    await sink({ kind: 'connect_attempt' }, { ts: FIXED_TS })
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' })
  })

  it('rejects with the status when the server does not accept the event', async () => {
    const { fetch } = fakeFetch(429)
    const sink = createHttpRtcSink({
      apiBaseUrl: 'http://localhost:3000',
      fetch,
      getAccessToken: () => '',
    })
    await expect(sink({ kind: 'connected' }, { ts: FIXED_TS })).rejects.toBeInstanceOf(RtcSinkError)
    await expect(sink({ kind: 'connected' }, { ts: FIXED_TS })).rejects.toMatchObject({
      status: 429,
    })
  })

  it('builds the url and accepts the global fetch signature', () => {
    expect(rtcDiagnosticsUrl('https://api.example///')).toBe(
      `https://api.example${RTC_DIAGNOSTICS_PATH}`,
    )
    const _globalFetchIsCompatible: FetchLike = globalThis.fetch
  })
})

describe('parseRtcDiagnosticEvent', () => {
  it('accepts a well-formed event and drops unknown keys', () => {
    expect(
      parseRtcDiagnosticEvent({
        kind: 'reconnecting',
        roomId: ROOM_ID,
        conversationId: CONVERSATION_ID,
        participantIdentity: IDENTITY,
        attempt: 2,
        durationMs: 1500.5,
        reason: 'ice_failed',
        code: 'E1',
        injected: 'nope',
      }),
    ).toEqual({
      kind: 'reconnecting',
      roomId: ROOM_ID,
      conversationId: CONVERSATION_ID,
      participantIdentity: IDENTITY,
      attempt: 2,
      durationMs: 1500.5,
      reason: 'ice_failed',
      code: 'E1',
    })
  })

  it.each(RTC_DIAGNOSTIC_KINDS)('round-trips a bare %s event', (kind) => {
    expect(parseRtcDiagnosticEvent({ kind })).toEqual({ kind })
    expect(parseRtcDiagnosticEvent(JSON.parse(JSON.stringify({ kind, roomId: ROOM_ID })))).toEqual({
      kind,
      roomId: ROOM_ID,
    })
  })

  it('accepts kind-specific fields', () => {
    expect(parseRtcDiagnosticEvent({ kind: 'token_error', httpStatus: 401 })).toEqual({
      kind: 'token_error',
      httpStatus: 401,
    })
    expect(
      parseRtcDiagnosticEvent({ kind: 'media_permission_denied', permission: 'camera' }),
    ).toEqual({
      kind: 'media_permission_denied',
      permission: 'camera',
    })
    expect(parseRtcDiagnosticEvent({ kind: 'media_device_error', source: 'camera' })).toEqual({
      kind: 'media_device_error',
      source: 'camera',
    })
    expect(
      parseRtcDiagnosticEvent({ kind: 'track_publish_failed', source: 'screen_share' }),
    ).toEqual({
      kind: 'track_publish_failed',
      source: 'screen_share',
    })
    expect(
      parseRtcDiagnosticEvent({ kind: 'track_subscribe_failed', source: 'microphone' }),
    ).toEqual({
      kind: 'track_subscribe_failed',
      source: 'microphone',
    })
    expect(parseRtcDiagnosticEvent({ kind: 'realtime_recovered', channel: 'presence' })).toEqual({
      kind: 'realtime_recovered',
      channel: 'presence',
    })
    expect(
      parseRtcDiagnosticEvent({
        kind: 'realtime_poll_failed',
        channel: 'conversation',
        attempt: 0,
      }),
    ).toEqual({ kind: 'realtime_poll_failed', channel: 'conversation', attempt: 0 })
    expect(
      parseRtcDiagnosticEvent({
        kind: 'message_send_failed',
        conversationId: CONVERSATION_ID,
        attempt: 2,
        code: 'rate_limited',
      }),
    ).toEqual({
      kind: 'message_send_failed',
      conversationId: CONVERSATION_ID,
      attempt: 2,
      code: 'rate_limited',
    })
    expect(
      parseRtcDiagnosticEvent({
        kind: 'webhook_out_of_order',
        eventType: 'participant_left',
        eventId: 'e1',
      }),
    ).toEqual({ kind: 'webhook_out_of_order', eventType: 'participant_left', eventId: 'e1' })
  })

  it('scrubs secrets out of the reason of untrusted events', () => {
    expect(
      parseRtcDiagnosticEvent({ kind: 'connect_failed', reason: 'signal failed: Bearer abc' }),
    ).toEqual({ kind: 'connect_failed', reason: 'signal failed: Bearer [REDACTED]' })
  })

  it.each([
    ['not an object', 'connected'],
    ['an array', ['connected']],
    ['an unknown kind', { kind: 'exploded' }],
    ['a malformed roomId', { kind: 'connected', roomId: 'room-1' }],
    ['a malformed conversationId', { kind: 'connected', conversationId: 42 }],
    ['a malformed identity', { kind: 'connected', participantIdentity: 'x:nope' }],
    ['a negative attempt', { kind: 'reconnecting', attempt: -1 }],
    ['a fractional attempt', { kind: 'reconnecting', attempt: 1.5 }],
    ['a non-numeric duration', { kind: 'connected', durationMs: '12' }],
    ['a negative duration', { kind: 'connected', durationMs: -1 }],
    ['an empty reason', { kind: 'disconnected', reason: '' }],
    ['an oversized code', { kind: 'token_error', code: 'x'.repeat(101) }],
    ['a fractional http status', { kind: 'token_error', httpStatus: 401.5 }],
    ['an out-of-range http status', { kind: 'token_error', httpStatus: RTC_HTTP_STATUS_MAX + 1 }],
    ['an unknown channel', { kind: 'realtime_fallback', channel: 'feed' }],
    ['a poll failure on an unknown channel', { kind: 'realtime_poll_failed', channel: 'feed' }],
    ['an unknown permission', { kind: 'media_permission_denied', permission: 'location' }],
    ['an unknown track source', { kind: 'track_publish_failed', source: 'data' }],
    ['a device error with an unknown source', { kind: 'media_device_error', source: 'gps' }],
    ['a non-string eventType', { kind: 'webhook_out_of_order', eventType: 7 }],
  ])('rejects %s', (_label, input) => {
    expect(parseRtcDiagnosticEvent(input)).toBeNull()
  })
})

describe('parseRtcDiagnosticEnvelope', () => {
  it('accepts the wire format produced by the http sink', () => {
    const envelope = { v: 1, ts: FIXED_TS, event: { kind: 'connected', roomId: ROOM_ID } }
    expect(parseRtcDiagnosticEnvelope(JSON.parse(JSON.stringify(envelope)))).toEqual(envelope)
  })

  it.each([
    ['a different version', { v: 2, ts: FIXED_TS, event: { kind: 'connected' } }],
    ['a missing timestamp', { v: 1, event: { kind: 'connected' } }],
    ['an unparseable timestamp', { v: 1, ts: 'yesterday', event: { kind: 'connected' } }],
    ['an invalid event', { v: 1, ts: FIXED_TS, event: { kind: 'nope' } }],
    ['no event', { v: 1, ts: FIXED_TS }],
    ['a scalar', 'envelope'],
  ])('rejects %s', (_label, input) => {
    expect(parseRtcDiagnosticEnvelope(input)).toBeNull()
  })
})
