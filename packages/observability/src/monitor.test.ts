import { EarthError, asGuestSessionId, asHumanId } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { createLogger, createMemorySink, type LogLevel } from './logger'
import {
  BREADCRUMB_CATEGORIES,
  DEFAULT_MAX_BREADCRUMBS,
  EARTH_ERROR_CODE_TAG,
  EARTH_ERROR_DETAILS_KEY,
  MONITOR_LOG_MESSAGES,
  MONITOR_SEVERITIES,
  MONITOR_SEVERITY_LOG_LEVEL,
  type Breadcrumb,
  type ErrorMonitor,
  type MonitorIdentity,
  type MonitorSeverity,
  createCompositeMonitor,
  createConsoleMonitor,
  createNoopMonitor,
  createRecordingMonitor,
  enrichContextForError,
  isMonitorSeverity,
} from './monitor'
import { REDACTED_VALUE } from './redact'

const HUMAN: MonitorIdentity = {
  kind: 'human',
  id: asHumanId('33333333-3333-4333-8333-333333333333'),
  handle: 'maya',
}
const GUEST: MonitorIdentity = {
  kind: 'guest',
  id: asGuestSessionId('44444444-4444-4444-8444-444444444444'),
}
const FIXED_TS = '2026-09-03T12:00:00.000Z'
const now = (): Date => new Date(FIXED_TS)

function setup(maxBreadcrumbs?: number) {
  const memory = createMemorySink()
  const logger = createLogger({ sink: memory.sink, level: 'debug', now })
  const monitor = createConsoleMonitor(
    logger,
    maxBreadcrumbs === undefined ? { now } : { now, maxBreadcrumbs },
  )
  return { memory, monitor }
}

describe('createNoopMonitor', () => {
  it('accepts every call and flushes true', async () => {
    const monitor = createNoopMonitor()
    expect(() => {
      monitor.captureException(new Error('x'))
      monitor.captureMessage('m')
      monitor.setUser(HUMAN)
      monitor.setRelease('earth-web@1.0.0')
      monitor.addBreadcrumb({ category: 'ui', message: 'tap' })
    }).not.toThrow()
    await expect(monitor.flush?.()).resolves.toBe(true)
  })
})

describe('createConsoleMonitor', () => {
  it('logs captured exceptions at error with the serialised error, scope and breadcrumbs', () => {
    const { memory, monitor } = setup()
    monitor.setUser(HUMAN)
    monitor.setRelease('earth-web@1.0.0+abc1234')
    monitor.addBreadcrumb({ category: 'navigation', message: 'open room', data: { token: 'x' } })
    memory.clear()

    monitor.captureException(new Error('boom'), { tags: { route: 'rooms' }, extra: { a: 1 } })

    expect(memory.records).toHaveLength(1)
    const record = memory.records[0]
    expect(record?.level).toBe('error')
    expect(record?.msg).toBe(MONITOR_LOG_MESSAGES.exception)
    expect(record?.fields).toMatchObject({
      error: { name: 'Error', message: 'boom' },
      tags: { route: 'rooms' },
      extra: { a: 1 },
      user: HUMAN,
      release: 'earth-web@1.0.0+abc1234',
      breadcrumbs: [
        {
          category: 'navigation',
          message: 'open room',
          data: { token: REDACTED_VALUE },
          timestampMs: new Date(FIXED_TS).getTime(),
        },
      ],
    })
  })

  it('tags EarthError codes and carries their details', () => {
    const { memory, monitor } = setup()
    monitor.captureException(new EarthError('consent_required', { details: { roomId: 'r' } }), {
      tags: { route: 'rooms' },
    })
    expect(memory.records[0]?.fields).toMatchObject({
      error: { code: 'consent_required' },
      tags: { route: 'rooms', [EARTH_ERROR_CODE_TAG]: 'consent_required' },
      extra: { [EARTH_ERROR_DETAILS_KEY]: { roomId: 'r' } },
    })
  })

  it.each(MONITOR_SEVERITIES)('logs a %s message at the mapped level', (severity) => {
    const { memory, monitor } = setup()
    monitor.captureMessage('note', severity, { extra: { k: 1 } })
    expect(memory.records[0]?.level).toBe(MONITOR_SEVERITY_LOG_LEVEL[severity])
    expect(memory.records[0]?.msg).toBe('note')
    expect(memory.records[0]?.fields).toMatchObject({ severity, extra: { k: 1 } })
  })

  it('defaults messages to info severity', () => {
    const { memory, monitor } = setup()
    monitor.captureMessage('plain')
    expect(memory.records[0]?.level).toBe('info')
    expect(memory.records[0]?.fields).toMatchObject({ severity: 'info' })
  })

  it('clears the user with null and omits it from later captures', () => {
    const { memory, monitor } = setup()
    monitor.setUser(GUEST)
    monitor.setUser(null)
    memory.clear()
    monitor.captureMessage('after clear')
    expect(memory.records[0]?.fields).not.toHaveProperty('user')
  })

  it('keeps only the most recent breadcrumbs and logs each one at debug', () => {
    const { memory, monitor } = setup(2)
    const crumbs: Breadcrumb[] = [1, 2, 3].map((n) => ({
      category: 'http',
      message: `call ${n}`,
      timestampMs: n,
    }))
    for (const crumb of crumbs) monitor.addBreadcrumb(crumb)
    expect(memory.records.map((record) => [record.level, record.msg])).toEqual([
      ['debug', MONITOR_LOG_MESSAGES.breadcrumb],
      ['debug', MONITOR_LOG_MESSAGES.breadcrumb],
      ['debug', MONITOR_LOG_MESSAGES.breadcrumb],
    ])
    memory.clear()
    monitor.captureException(new Error('x'))
    expect(memory.records[0]?.fields).toMatchObject({ breadcrumbs: [crumbs[1], crumbs[2]] })
    expect(DEFAULT_MAX_BREADCRUMBS).toBe(50)
  })

  it('flushes true', async () => {
    const { monitor } = setup()
    await expect(monitor.flush?.(10)).resolves.toBe(true)
  })
})

describe('enrichContextForError', () => {
  it('passes non-Earth errors through untouched', () => {
    const context = { tags: { a: 'b' } }
    expect(enrichContextForError(new Error('x'), context)).toBe(context)
    expect(enrichContextForError(new Error('x'))).toBeUndefined()
  })

  it('adds the code tag without details when the error has none', () => {
    expect(enrichContextForError(new EarthError('blocked'))).toEqual({
      tags: { [EARTH_ERROR_CODE_TAG]: 'blocked' },
    })
  })

  it('preserves fingerprint and existing extra', () => {
    expect(
      enrichContextForError(new EarthError('blocked', { details: { by: 'h' } }), {
        extra: { x: 1 },
        fingerprint: ['f'],
      }),
    ).toEqual({
      tags: { [EARTH_ERROR_CODE_TAG]: 'blocked' },
      extra: { x: 1, [EARTH_ERROR_DETAILS_KEY]: { by: 'h' } },
      fingerprint: ['f'],
    })
  })
})

describe('createRecordingMonitor', () => {
  it('records every call in order', async () => {
    const recording = createRecordingMonitor()
    const error = new Error('x')
    recording.monitor.captureException(error)
    recording.monitor.captureMessage('m', 'warning', { tags: { t: 1 } })
    recording.monitor.setUser(HUMAN)
    recording.monitor.setRelease('r')
    recording.monitor.addBreadcrumb({ category: 'rtc', message: 'c' })
    await recording.monitor.flush?.(5)
    expect(recording.calls).toEqual([
      { method: 'captureException', error },
      { method: 'captureMessage', message: 'm', level: 'warning', context: { tags: { t: 1 } } },
      { method: 'setUser', identity: HUMAN },
      { method: 'setRelease', release: 'r' },
      { method: 'addBreadcrumb', crumb: { category: 'rtc', message: 'c' } },
      { method: 'flush', timeoutMs: 5 },
    ])
    recording.clear()
    expect(recording.calls).toEqual([])
  })
})

describe('createCompositeMonitor', () => {
  it('fans out to every monitor even when one throws, and aggregates flush', async () => {
    const first = createRecordingMonitor()
    const second = createRecordingMonitor()
    const broken: ErrorMonitor = {
      captureException: () => {
        throw new Error('adapter down')
      },
      captureMessage: () => undefined,
      setUser: () => undefined,
      setRelease: () => undefined,
      addBreadcrumb: () => undefined,
      flush: () => Promise.resolve(false),
    }
    const composite = createCompositeMonitor([first.monitor, broken, second.monitor])

    expect(() => composite.captureException(new Error('x'))).not.toThrow()
    composite.setRelease('r')
    expect(first.calls.map((call) => call.method)).toEqual(['captureException', 'setRelease'])
    expect(second.calls.map((call) => call.method)).toEqual(['captureException', 'setRelease'])

    await expect(composite.flush?.()).resolves.toBe(false)
    await expect(createCompositeMonitor([first.monitor, second.monitor]).flush?.()).resolves.toBe(
      true,
    )
  })
})

describe('constants', () => {
  it('maps every severity to a logger level and exposes the categories', () => {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error']
    for (const severity of MONITOR_SEVERITIES) {
      expect(levels).toContain(MONITOR_SEVERITY_LOG_LEVEL[severity])
      expect(isMonitorSeverity(severity)).toBe(true)
    }
    const notSeverity: unknown = 'critical'
    expect(isMonitorSeverity(notSeverity)).toBe(false)
    expect(BREADCRUMB_CATEGORIES).toContain('rtc')
    const severities: readonly MonitorSeverity[] = MONITOR_SEVERITIES
    expect(severities).toHaveLength(5)
  })
})

describe('createCompositeMonitor flush resilience', () => {
  it('treats a throwing or rejecting flush as not flushed without rejecting itself', async () => {
    const healthy = createRecordingMonitor()
    const throwing: ErrorMonitor = {
      ...createNoopMonitor(),
      flush: () => {
        throw new Error('adapter down')
      },
    }
    const rejecting: ErrorMonitor = {
      ...createNoopMonitor(),
      flush: () => Promise.reject(new Error('adapter down')),
    }

    await expect(createCompositeMonitor([throwing, healthy.monitor]).flush?.(5)).resolves.toBe(
      false,
    )
    expect(healthy.calls).toEqual([{ method: 'flush', timeoutMs: 5 }])
    await expect(createCompositeMonitor([rejecting]).flush?.()).resolves.toBe(false)
  })
})
