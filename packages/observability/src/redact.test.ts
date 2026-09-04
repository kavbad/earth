import { EarthError } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import {
  CIRCULAR_VALUE,
  MAX_ERROR_CAUSE_DEPTH,
  MAX_SERIALIZATION_DEPTH,
  NON_ERROR_NAME,
  REDACTED_EXACT_KEYS,
  REDACTED_KEYS,
  REDACTED_VALUE,
  TRUNCATED_VALUE,
  UNSERIALIZABLE_FIELDS,
  UNSERIALIZABLE_VALUE,
  isRedactedKey,
  redactFields,
  redactString,
  safeStringify,
  sanitizeValue,
  serializeError,
} from './redact'

describe('isRedactedKey', () => {
  it.each(REDACTED_KEYS)('redacts the exact key %s', (key) => {
    expect(isRedactedKey(key)).toBe(true)
  })

  it.each([
    'Authorization',
    'API_KEY',
    'api-key',
    'sessionSecret',
    'SESSION-SECRET',
    'accessToken',
    'access_token',
    'livekit_token',
    'clientSecret',
    'x-authorization',
    'PASSWORD',
  ])('redacts case and separator variants such as %s', (key) => {
    expect(isRedactedKey(key)).toBe(true)
  })

  it.each(['token_hash', 'tokenCount', 'roomId', 'handle', 'secretive', 'passwordless', ''])(
    'keeps non-sensitive keys such as %j',
    (key) => {
      expect(isRedactedKey(key)).toBe(false)
    },
  )
})

describe('redactFields', () => {
  it('replaces sensitive values at every depth, including inside arrays', () => {
    const out = redactFields({
      token: 'abc',
      nested: { password: 'p', keep: 1, deeper: { apiKey: 'k' } },
      list: [{ authorization: 'Bearer x', ok: true }],
      session_secret: 's',
    })
    expect(out).toEqual({
      token: REDACTED_VALUE,
      nested: { password: REDACTED_VALUE, keep: 1, deeper: { apiKey: REDACTED_VALUE } },
      list: [{ authorization: REDACTED_VALUE, ok: true }],
      session_secret: REDACTED_VALUE,
    })
  })

  it('redacts whole objects held under a sensitive key', () => {
    expect(redactFields({ secret: { inner: 'x' } })).toEqual({ secret: REDACTED_VALUE })
  })

  it('keeps null and drops undefined sensitive values (nothing to leak)', () => {
    expect(redactFields({ token: null, password: undefined, a: undefined })).toEqual({
      token: null,
    })
  })

  it('does not mutate its input', () => {
    const input = { token: 'abc', nested: { secret: 'x' } }
    redactFields(input)
    expect(input).toEqual({ token: 'abc', nested: { secret: 'x' } })
  })
})

describe('sanitizeValue', () => {
  it('converts dates, bigints, symbols, functions, maps and sets to JSON-safe data', () => {
    const date = new Date('2026-09-03T12:00:00.000Z')
    function named(): void {}
    expect(
      sanitizeValue({
        date,
        big: 10n,
        sym: Symbol('s'),
        fn: named,
        map: new Map<string, unknown>([
          ['token', 'x'],
          ['k', 1],
        ]),
        set: new Set([1, 2]),
        nan: Number.NaN,
      }),
    ).toEqual({
      date: '2026-09-03T12:00:00.000Z',
      big: '10',
      sym: 'Symbol(s)',
      fn: '[Function named]',
      map: { token: REDACTED_VALUE, k: 1 },
      set: [1, 2],
      nan: 'NaN',
    })
  })

  it('marks cycles instead of throwing, but allows the same object twice as siblings', () => {
    const shared = { v: 1 }
    const cyclic: Record<string, unknown> = { shared, again: shared }
    cyclic.self = cyclic
    expect(sanitizeValue(cyclic)).toEqual({
      shared: { v: 1 },
      again: { v: 1 },
      self: CIRCULAR_VALUE,
    })
  })

  it('truncates beyond the maximum depth', () => {
    let value: Record<string, unknown> = { leaf: true }
    for (let i = 0; i < MAX_SERIALIZATION_DEPTH + 2; i += 1) value = { next: value }
    const json = JSON.stringify(sanitizeValue(value))
    expect(json).toContain(TRUNCATED_VALUE)
    expect(json).not.toContain('leaf')
  })

  it('serialises errors found inside fields', () => {
    const out = sanitizeValue({ error: new RangeError('bad') }) as { error: { name: string } }
    expect(out.error.name).toBe('RangeError')
  })
})

describe('serializeError', () => {
  it('captures name, message and stack of plain errors', () => {
    const out = serializeError(new TypeError('boom'))
    expect(out.name).toBe('TypeError')
    expect(out.message).toBe('boom')
    expect(typeof out.stack).toBe('string')
    expect(out).not.toHaveProperty('code')
  })

  it('captures EarthError code and redacted details', () => {
    const error = new EarthError('rate_limited', {
      details: { action: 'message_send', token: 'x' },
    })
    const out = serializeError(error)
    expect(out.code).toBe('rate_limited')
    expect(out.details).toEqual({ action: 'message_send', token: REDACTED_VALUE })
  })

  it('captures string codes on other errors and follows the cause chain up to the limit', () => {
    const root = Object.assign(new Error('socket'), { code: 'ECONNRESET' })
    let error: Error = root
    for (let i = 0; i < MAX_ERROR_CAUSE_DEPTH + 2; i += 1) {
      error = new Error(`layer ${i}`, { cause: error })
    }
    const out = serializeError(error)
    let depth = 0
    let cursor = out
    while (cursor.cause !== undefined) {
      cursor = cursor.cause
      depth += 1
    }
    expect(depth).toBe(MAX_ERROR_CAUSE_DEPTH)
    expect(serializeError(root).code).toBe('ECONNRESET')
  })

  it('describes non-error throwables', () => {
    expect(serializeError('nope')).toEqual({ name: NON_ERROR_NAME, message: 'nope' })
    expect(serializeError({ token: 'x', a: 1 })).toEqual({
      name: NON_ERROR_NAME,
      message: JSON.stringify({ token: REDACTED_VALUE, a: 1 }),
    })
  })
})

describe('safeStringify', () => {
  it('never throws', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(safeStringify(cyclic)).toBe(JSON.stringify({ self: CIRCULAR_VALUE }))
    expect(safeStringify(undefined)).toBe('undefined')
  })
})

describe('isRedactedKey — server secrets and PII', () => {
  it.each(REDACTED_EXACT_KEYS)('redacts the exact key %s', (key) => {
    expect(isRedactedKey(key)).toBe(true)
  })

  it.each([
    // ARCHITECTURE §14 server secrets, as their env names.
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_JWT_SECRET',
    'LIVEKIT_API_KEY',
    'LIVEKIT_API_SECRET',
    'HUMAN_VERIFICATION_VENDOR_KEY',
    'HUMAN_VERIFICATION_WEBHOOK_SECRET',
    'EXPO_ACCESS_TOKEN',
    'INTERNAL_CRON_SECRET',
    'POSTHOG_SERVER_KEY',
    // Compound and header forms.
    'secretKey',
    'privateKey',
    'serviceRoleKey',
    'Cookie',
    'set-cookie',
    'supabaseJwt',
    'emailOtp',
    'credentials',
    // PII (spec §128; monitor identity is id + handle only).
    'userEmail',
    'Phone',
    'phoneNumber',
    'LAT',
    'lng',
    'latitude',
    'coords',
  ])('redacts %s', (key) => {
    expect(isRedactedKey(key)).toBe(true)
  })

  it.each([
    'microphone',
    'flat',
    'salon',
    'key',
    'flagKey',
    'cacheKey',
    'idempotencyKey',
    'emailVerified',
    'latency',
    'cursor',
    'roomId',
    'participantIdentity',
  ])('keeps %s (no over-matching of short suffixes)', (key) => {
    expect(isRedactedKey(key)).toBe(false)
  })
})

describe('redactString', () => {
  it.each([
    ['bearer credentials', 'Authorization: Bearer abc.def-ghi', 'Authorization: Bearer [REDACTED]'],
    ['basic credentials', 'authorization: basic dXNlcjpwYXNz=', 'authorization: basic [REDACTED]'],
    [
      'LiveKit signalling urls',
      'wss://lk.example/rtc?access_token=eyJa.b&protocol=9',
      'wss://lk.example/rtc?access_token=[REDACTED]&protocol=9',
    ],
    [
      'jwts',
      'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123 expired',
      'token [REDACTED] expired',
    ],
    [
      'url userinfo',
      'postgres://postgres:postgres@127.0.0.1:5432/postgres',
      'postgres://[REDACTED]@127.0.0.1:5432/postgres',
    ],
    [
      'bare key params',
      'https://maps.example/style?key=AIzaSy123&q=x',
      'https://maps.example/style?key=[REDACTED]&q=x',
    ],
    [
      'connection strings',
      'host=db password=hunter2 user=earth',
      'host=db password=[REDACTED] user=earth',
    ],
    [
      'auth fragments',
      'https://earth.social/auth#access_token=abc&type=magiclink',
      'https://earth.social/auth#access_token=[REDACTED]&type=magiclink',
    ],
  ])('scrubs %s', (_label, input, expected) => {
    expect(redactString(input)).toBe(expected)
  })

  it.each([
    'room h:123 joined',
    'cursor eyJ2IjoxLCJzIjoiYSJ9',
    'https://earth.social/@maya',
    'x=1&scope=friends',
    'Bearer',
    '',
  ])('leaves %j alone', (input) => {
    expect(redactString(input)).toBe(input)
  })

  it('scrubs strings inside fields and inside error messages and stacks', () => {
    const error = new Error('connect failed: wss://x/rtc?access_token=abc123')
    const out = redactFields({ url: 'https://x/?token=t', error, note: 'Bearer zzz' })
    expect(out.url).toBe('https://x/?token=[REDACTED]')
    expect(out.note).toBe('Bearer [REDACTED]')
    const serialized = out.error as { message: string; stack?: string }
    expect(serialized.message).toBe('connect failed: wss://x/rtc?access_token=[REDACTED]')
    expect(serialized.stack).toContain('connect failed')
    expect(JSON.stringify(out)).not.toContain('abc123')
    expect(serializeError('thrown Bearer abc').message).toBe('thrown Bearer [REDACTED]')
  })
})

describe('serialisation never throws', () => {
  it('survives an EarthError whose details reference the error', () => {
    const details: Record<string, unknown> = {}
    const error = new EarthError('internal', { details })
    details.self = error
    details.list = [error]
    expect(serializeError(error).details).toEqual({ self: CIRCULAR_VALUE, list: [CIRCULAR_VALUE] })
    expect(() => redactFields({ error })).not.toThrow()
  })

  it('marks a self-referencing cause and an object cause that holds the error', () => {
    const self = new Error('self')
    ;(self as { cause?: unknown }).cause = self
    expect(serializeError(self).cause).toEqual({ name: 'Error', message: CIRCULAR_VALUE })

    const held = new Error('held')
    ;(held as { cause?: unknown }).cause = { held }
    expect(serializeError(held).cause).toEqual({
      name: NON_ERROR_NAME,
      message: JSON.stringify({ held: CIRCULAR_VALUE }),
    })
  })

  it('serialises the same error twice as siblings', () => {
    const shared = new Error('shared')
    const out = sanitizeValue({ a: shared, b: shared }) as {
      a: { message: string }
      b: { message: string }
    }
    expect(out.a.message).toBe('shared')
    expect(out.b.message).toBe('shared')
  })

  it('bounds an error nested through details by depth, not by the stack', () => {
    let error = new EarthError('internal', { details: { leaf: true } })
    for (let i = 0; i < MAX_SERIALIZATION_DEPTH + 2; i += 1) {
      error = new EarthError('internal', { details: { inner: error } })
    }
    const json = JSON.stringify(serializeError(error))
    expect(json).toContain(TRUNCATED_VALUE)
    expect(json).not.toContain('leaf')
  })

  it('replaces fields whose getters throw instead of throwing', () => {
    const hostile = {
      get boom(): never {
        throw new Error('no')
      },
    }
    expect(redactFields(hostile)).toEqual(UNSERIALIZABLE_FIELDS)
    expect(redactFields({ nested: hostile, ok: 1 })).toEqual({
      nested: UNSERIALIZABLE_VALUE,
      ok: 1,
    })
    const details: Record<string, unknown> = { hostile }
    expect(serializeError(new EarthError('internal', { details })).details).toEqual({
      hostile: UNSERIALIZABLE_VALUE,
    })
    expect(safeStringify(hostile)).toBe(JSON.stringify(UNSERIALIZABLE_VALUE))
  })
})
