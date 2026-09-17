import { EarthError } from '@earth/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  SERIALIZATION_FAILED_FIELDS,
  SINK_FAILURE_MESSAGE,
  type ConsoleLike,
  type LogLevel,
  createConsoleSink,
  createLogger,
  createMemorySink,
  createNoopLogger,
  formatLogRecord,
  isLevelEnabled,
  isLogLevel,
  parseLogLevel,
} from './logger'
import { REDACTED_VALUE } from './redact'

const FIXED_TS = '2026-09-03T12:00:00.000Z'
const now = (): Date => new Date(FIXED_TS)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createLogger', () => {
  it('emits one line of JSON with level, ts, msg and fields in that order', () => {
    const memory = createMemorySink()
    const logger = createLogger({ sink: memory.sink, now, level: 'debug' })

    logger.info('hello', { a: 1, b: 'two' })

    expect(memory.lines).toHaveLength(1)
    const line = memory.lines[0]
    expect(line).toBe(
      JSON.stringify({ level: 'info', ts: FIXED_TS, msg: 'hello', fields: { a: 1, b: 'two' } }),
    )
    expect(Object.keys(JSON.parse(line ?? '{}') as object)).toEqual([
      'level',
      'ts',
      'msg',
      'fields',
    ])
    expect(memory.records[0]).toEqual({
      level: 'info',
      ts: FIXED_TS,
      msg: 'hello',
      fields: { a: 1, b: 'two' },
    })
  })

  it('always stays on a single line, even with newlines in message or fields', () => {
    const memory = createMemorySink()
    const logger = createLogger({ sink: memory.sink, now })
    logger.warn('first\nsecond', { text: 'a\r\nb' })
    expect(memory.lines[0]).not.toMatch(/[\r\n]/)
    expect(JSON.parse(memory.lines[0] ?? '{}')).toMatchObject({ msg: 'first\nsecond' })
  })

  it('emits an empty fields object when no fields are given', () => {
    const memory = createMemorySink()
    createLogger({ sink: memory.sink, now, level: 'debug' }).debug('x')
    expect(memory.records[0]?.fields).toEqual({})
  })

  it.each<[LogLevel, LogLevel[]]>([
    ['debug', ['debug', 'info', 'warn', 'error']],
    ['info', ['info', 'warn', 'error']],
    ['warn', ['warn', 'error']],
    ['error', ['error']],
  ])('at level %s emits only %j', (level, expected) => {
    const memory = createMemorySink()
    const logger = createLogger({ sink: memory.sink, now, level })
    for (const call of LOG_LEVELS) logger[call](call)
    expect(memory.records.map((record) => record.level)).toEqual(expected)
  })

  it('defaults to the info level', () => {
    expect(DEFAULT_LOG_LEVEL).toBe('info')
    const memory = createMemorySink()
    const logger = createLogger({ sink: memory.sink, now })
    logger.debug('hidden')
    logger.info('shown')
    expect(memory.records.map((record) => record.msg)).toEqual(['shown'])
  })

  it('merges base fields, child fields and call fields with the innermost winning', () => {
    const memory = createMemorySink()
    const root = createLogger({ sink: memory.sink, now, base: { app: 'earth-web', scope: 'root' } })
    const child = root.child({ scope: 'child', requestId: 'r1' })
    const grandchild = child.child({ scope: 'grandchild' })

    root.info('root')
    child.info('child')
    grandchild.info('grandchild', { scope: 'call', extra: true })

    expect(memory.records.map((record) => record.fields)).toEqual([
      { app: 'earth-web', scope: 'root' },
      { app: 'earth-web', scope: 'child', requestId: 'r1' },
      { app: 'earth-web', scope: 'call', requestId: 'r1', extra: true },
    ])
  })

  it('child loggers keep the sink and level of their parent', () => {
    const memory = createMemorySink()
    const child = createLogger({ sink: memory.sink, now, level: 'warn' }).child({ c: 1 })
    child.info('dropped')
    child.error('kept')
    expect(memory.records.map((record) => record.msg)).toEqual(['kept'])
  })

  it('redacts sensitive keys in base, child and call fields', () => {
    const memory = createMemorySink()
    const logger = createLogger({ sink: memory.sink, now, base: { apiKey: 'base-key' } }).child({
      session_secret: 'child-secret',
    })
    logger.info('login', {
      token: 't',
      secret: 's',
      password: 'p',
      authorization: 'Bearer abc',
      user: { accessToken: 'x', handle: 'maya' },
      tokenCount: 3,
    })
    expect(memory.records[0]?.fields).toEqual({
      apiKey: REDACTED_VALUE,
      session_secret: REDACTED_VALUE,
      token: REDACTED_VALUE,
      secret: REDACTED_VALUE,
      password: REDACTED_VALUE,
      authorization: REDACTED_VALUE,
      user: { accessToken: REDACTED_VALUE, handle: 'maya' },
      tokenCount: 3,
    })
    expect(memory.lines[0]).not.toContain('Bearer abc')
  })

  it('serialises Error fields including EarthError codes', () => {
    const memory = createMemorySink()
    const logger = createLogger({ sink: memory.sink, now })
    logger.error('failed', { error: new EarthError('not_a_member', { details: { groupId: 'g' } }) })
    expect(memory.records[0]?.fields).toMatchObject({
      error: {
        name: 'EarthError',
        message: 'not_a_member',
        code: 'not_a_member',
        details: { groupId: 'g' },
      },
    })
  })

  it('never throws when the sink throws, and reports the failure to console.error', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const failure = new Error('sink down')
    const logger = createLogger({
      sink: () => {
        throw failure
      },
      now,
    })
    expect(() => logger.info('x')).not.toThrow()
    expect(consoleError).toHaveBeenCalledWith(SINK_FAILURE_MESSAGE, failure)
  })

  it('uses a console sink by default', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    createLogger({ now }).info('default sink')
    expect(info).toHaveBeenCalledWith(
      JSON.stringify({ level: 'info', ts: FIXED_TS, msg: 'default sink', fields: {} }),
    )
  })
})

describe('createConsoleSink', () => {
  it('routes each level to the matching console method', () => {
    const calls: string[] = []
    const target: ConsoleLike = {
      debug: () => calls.push('debug'),
      info: () => calls.push('info'),
      warn: () => calls.push('warn'),
      error: () => calls.push('error'),
    }
    const logger = createLogger({ sink: createConsoleSink(target), now, level: 'debug' })
    for (const level of LOG_LEVELS) logger[level]('m')
    expect(calls).toEqual([...LOG_LEVELS])
  })
})

describe('createMemorySink', () => {
  it('clears both lines and records', () => {
    const memory = createMemorySink()
    createLogger({ sink: memory.sink, now }).info('a')
    memory.clear()
    expect(memory.lines).toEqual([])
    expect(memory.records).toEqual([])
  })
})

describe('level helpers', () => {
  it('parses environment-style values and falls back otherwise', () => {
    expect(parseLogLevel(' WARN ')).toBe('warn')
    expect(parseLogLevel('verbose')).toBe(DEFAULT_LOG_LEVEL)
    expect(parseLogLevel(undefined, 'error')).toBe('error')
    expect(parseLogLevel(3)).toBe(DEFAULT_LOG_LEVEL)
  })

  it('recognises levels and compares priorities', () => {
    expect(isLogLevel('debug')).toBe(true)
    expect(isLogLevel('trace')).toBe(false)
    expect(isLevelEnabled('warn', 'info')).toBe(true)
    expect(isLevelEnabled('info', 'warn')).toBe(false)
  })
})

describe('formatLogRecord', () => {
  it('keeps the message when a hand-built record cannot be serialised', () => {
    const line = formatLogRecord({ level: 'info', ts: FIXED_TS, msg: 'm', fields: { big: 1n } })
    expect(JSON.parse(line)).toEqual({
      level: 'info',
      ts: FIXED_TS,
      msg: 'm',
      fields: { serialization_failed: true },
    })
  })
})

describe('createNoopLogger', () => {
  it('accepts every call and returns itself as child', () => {
    const logger = createNoopLogger()
    expect(() => {
      logger.debug('a')
      logger.info('b', { x: 1 })
      logger.warn('c')
      logger.error('d')
    }).not.toThrow()
    expect(logger.child({ a: 1 })).toBe(logger)
  })
})

describe('createLogger string redaction and resilience', () => {
  it('scrubs secrets inside the message and inside string fields', () => {
    const memory = createMemorySink()
    const logger = createLogger({ sink: memory.sink, now })
    logger.error('token refresh failed for Bearer abc.def', {
      url: 'wss://lk/rtc?access_token=xyz',
      jwt: 'eyJ',
    })
    expect(memory.records[0]).toEqual({
      level: 'error',
      ts: FIXED_TS,
      msg: 'token refresh failed for Bearer [REDACTED]',
      fields: { url: 'wss://lk/rtc?access_token=[REDACTED]', jwt: REDACTED_VALUE },
    })
    expect(memory.lines[0]).not.toContain('abc.def')
    expect(memory.lines[0]).not.toContain('xyz')
  })

  it('never throws when fields cannot be read, and still emits the message', () => {
    const memory = createMemorySink()
    const logger = createLogger({ sink: memory.sink, now })
    const hostile = {
      get boom(): never {
        throw new Error('no')
      },
    }
    expect(() => logger.info('survived', hostile)).not.toThrow()
    expect(memory.records[0]).toEqual({
      level: 'info',
      ts: FIXED_TS,
      msg: 'survived',
      fields: SERIALIZATION_FAILED_FIELDS,
    })
  })
})
