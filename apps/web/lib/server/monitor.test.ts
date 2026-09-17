import { EarthError } from '@earth/domain'
import {
  SENTRY_RELEASE_TAG,
  createLogger,
  createMemorySink,
  createRecordingMonitor,
} from '@earth/observability'
import { describe, expect, it } from 'vitest'

import { createFakeSentry } from './fakes'
import { LOG_CODE_FIELD, createMonitoringSink, createServerMonitor } from './monitor'

const RELEASE = 'earth-web@0.1.0+abc1234'

describe('createServerMonitor', () => {
  it('is a no-op monitor without a DSN and never initialises Sentry', () => {
    const sentry = createFakeSentry()
    const { kind, monitor } = createServerMonitor({
      dsn: undefined,
      appEnv: 'development',
      release: RELEASE,
      sentry: sentry.sdk,
    })
    expect(kind).toBe('noop')
    monitor.captureException(new Error('x'))
    expect(sentry.inits).toEqual([])
    expect(sentry.exceptions).toEqual([])
  })

  it('is a no-op monitor when no SDK is injected even with a DSN', () => {
    const { kind } = createServerMonitor({
      dsn: 'https://key@sentry.example/1',
      appEnv: 'production',
      release: RELEASE,
      sentry: undefined,
    })
    expect(kind).toBe('noop')
  })

  it('initialises Sentry with the DSN, environment and release and reports through it', () => {
    const sentry = createFakeSentry()
    const { kind, monitor } = createServerMonitor({
      dsn: 'https://key@sentry.example/1',
      appEnv: 'preview',
      release: RELEASE,
      sentry: sentry.sdk,
      now: () => new Date('2026-09-03T12:00:00.000Z'),
    })
    expect(kind).toBe('sentry')
    expect(sentry.inits).toEqual([
      {
        dsn: 'https://key@sentry.example/1',
        environment: 'preview',
        release: RELEASE,
        sendDefaultPii: false,
      },
    ])
    expect(sentry.tags).toEqual({ [SENTRY_RELEASE_TAG]: RELEASE })
    const error = new EarthError('rate_limited', { details: { action: 'message_send' } })
    monitor.captureException(error)
    expect(sentry.exceptions).toHaveLength(1)
    expect(sentry.exceptions[0]?.exception).toBe(error)
    expect(sentry.exceptions[0]?.context).toMatchObject({
      tags: { earth_error_code: 'rate_limited' },
    })
  })
})

describe('createMonitoringSink', () => {
  it('writes every record to the inner sink and forwards only error records', () => {
    const inner = createMemorySink()
    const recording = createRecordingMonitor()
    const logger = createLogger({
      level: 'debug',
      sink: createMonitoringSink(inner.sink, recording.monitor),
      now: () => new Date('2026-09-03T12:00:00.000Z'),
    })
    logger.debug('a')
    logger.info('b')
    logger.warn('c')
    logger.error('server.request_failed', { [LOG_CODE_FIELD]: 'internal', status: 500 })
    logger.error('plain', { status: 500 })

    expect(inner.records.map((record) => record.msg)).toEqual([
      'a',
      'b',
      'c',
      'server.request_failed',
      'plain',
    ])
    expect(recording.calls).toEqual([
      {
        method: 'captureMessage',
        message: 'server.request_failed',
        level: 'error',
        context: {
          tags: { [LOG_CODE_FIELD]: 'internal' },
          extra: { [LOG_CODE_FIELD]: 'internal', status: 500 },
        },
      },
      {
        method: 'captureMessage',
        message: 'plain',
        level: 'error',
        context: { extra: { status: 500 } },
      },
    ])
  })
})
