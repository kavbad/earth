import { EarthError, asGuestSessionId, asHumanId } from '@earth/domain'
import { describe, expect, it, vi } from 'vitest'

import { EARTH_ERROR_CODE_TAG, EARTH_ERROR_DETAILS_KEY, type MonitorIdentity } from '../monitor'
import { REDACTED_VALUE } from '../redact'
import {
  RELEASE_MAX_LENGTH,
  ReleaseFormatError,
  SENTRY_IDENTITY_KIND_KEY,
  SENTRY_RELEASE_TAG,
  type SentryLike,
  buildRelease,
  createSentryMonitor,
  parseRelease,
  redactTags,
  scrubException,
  toSentryScopeContext,
} from './sentry'

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

function fakeSentry() {
  return {
    captureException: vi.fn(() => 'event-1'),
    captureMessage: vi.fn(() => 'event-2'),
    setUser: vi.fn(),
    addBreadcrumb: vi.fn(),
    setTag: vi.fn(),
    flush: vi.fn(() => Promise.resolve(true)),
  } satisfies SentryLike
}

describe('createSentryMonitor', () => {
  it('forwards exceptions with tags, extra and fingerprint', () => {
    const sentry = fakeSentry()
    const monitor = createSentryMonitor(sentry, { now })
    const error = new Error('boom')

    monitor.captureException(error, {
      tags: { route: 'rooms' },
      extra: { attempt: 2 },
      fingerprint: ['rooms', 'join'],
    })

    expect(sentry.captureException).toHaveBeenCalledWith(error, {
      tags: { route: 'rooms' },
      extra: { attempt: 2 },
      fingerprint: ['rooms', 'join'],
    })
  })

  it('forwards exceptions without a context when none is given', () => {
    const sentry = fakeSentry()
    const error = new Error('boom')
    createSentryMonitor(sentry).captureException(error)
    expect(sentry.captureException).toHaveBeenCalledWith(error, undefined)
  })

  it('tags EarthError codes and attaches their details', () => {
    const sentry = fakeSentry()
    const error = new EarthError('rate_limited', { details: { action: 'message_send' } })
    createSentryMonitor(sentry).captureException(error)
    expect(sentry.captureException).toHaveBeenCalledWith(error, {
      tags: { [EARTH_ERROR_CODE_TAG]: 'rate_limited' },
      extra: { [EARTH_ERROR_DETAILS_KEY]: { action: 'message_send' } },
    })
  })

  it('forwards messages with their severity, defaulting to info', () => {
    const sentry = fakeSentry()
    const monitor = createSentryMonitor(sentry)
    monitor.captureMessage('plain')
    monitor.captureMessage('careful', 'warning', { tags: { rtc_kind: 'reconnecting' } })
    expect(sentry.captureMessage).toHaveBeenNthCalledWith(1, 'plain', { level: 'info' })
    expect(sentry.captureMessage).toHaveBeenNthCalledWith(2, 'careful', {
      level: 'warning',
      tags: { rtc_kind: 'reconnecting' },
    })
  })

  it('maps identities to Sentry users without PII and clears with null', () => {
    const sentry = fakeSentry()
    const monitor = createSentryMonitor(sentry)
    monitor.setUser(HUMAN)
    monitor.setUser(GUEST)
    monitor.setUser(null)
    expect(sentry.setUser).toHaveBeenNthCalledWith(1, {
      id: HUMAN.id,
      username: 'maya',
      [SENTRY_IDENTITY_KIND_KEY]: 'human',
    })
    expect(sentry.setUser).toHaveBeenNthCalledWith(2, {
      id: GUEST.id,
      [SENTRY_IDENTITY_KIND_KEY]: 'guest',
    })
    expect(sentry.setUser).toHaveBeenNthCalledWith(3, null)
  })

  it('forwards breadcrumbs with a seconds timestamp, stamping now when absent', () => {
    const sentry = fakeSentry()
    const monitor = createSentryMonitor(sentry, { now })
    monitor.addBreadcrumb({
      category: 'rtc',
      message: 'rtc.connected',
      level: 'info',
      data: { a: 1 },
    })
    monitor.addBreadcrumb({ category: 'ui', message: 'tap', timestampMs: 5000 })
    expect(sentry.addBreadcrumb).toHaveBeenNthCalledWith(1, {
      category: 'rtc',
      message: 'rtc.connected',
      level: 'info',
      data: { a: 1 },
      timestamp: new Date(FIXED_TS).getTime() / 1000,
    })
    expect(sentry.addBreadcrumb).toHaveBeenNthCalledWith(2, {
      category: 'ui',
      message: 'tap',
      timestamp: 5,
    })
  })

  it('records the release as a tag, at creation and on setRelease', () => {
    const sentry = fakeSentry()
    const monitor = createSentryMonitor(sentry, { release: 'earth-web@1.0.0+abc1234' })
    monitor.setRelease('earth-web@1.0.1+def5678')
    expect(sentry.setTag).toHaveBeenNthCalledWith(1, SENTRY_RELEASE_TAG, 'earth-web@1.0.0+abc1234')
    expect(sentry.setTag).toHaveBeenNthCalledWith(2, SENTRY_RELEASE_TAG, 'earth-web@1.0.1+def5678')
  })

  it('forwards flush and resolves true when the SDK has no flush or setTag', async () => {
    const sentry = fakeSentry()
    await expect(createSentryMonitor(sentry).flush?.(2000)).resolves.toBe(true)
    expect(sentry.flush).toHaveBeenCalledWith(2000)

    const minimal: SentryLike = {
      captureException: () => undefined,
      captureMessage: () => undefined,
      setUser: () => undefined,
      addBreadcrumb: () => undefined,
    }
    const monitor = createSentryMonitor(minimal)
    expect(() => monitor.setRelease('earth-web@1.0.0')).not.toThrow()
    await expect(monitor.flush?.()).resolves.toBe(true)
  })

  it('is satisfied structurally by an object shaped like a real Sentry SDK namespace', () => {
    // Mirrors the signatures of @sentry/node, @sentry/nextjs and @sentry/react-native without
    // importing any of them; a change to `SentryLike` that breaks injection fails here.
    type Primitive = number | string | boolean | bigint | symbol | null | undefined
    const sdk = {
      captureException(_exception: unknown, _hint?: object | ((scope: object) => object)): string {
        return 'id'
      },
      captureMessage(_message: string, _captureContext?: object | string): string {
        return 'id'
      },
      setUser(_user: { id?: string | number; [key: string]: unknown } | null): void {},
      addBreadcrumb(_breadcrumb: object, _hint?: object): void {},
      setTag(_key: string, _value: Primitive): void {},
      flush(_timeout?: number): Promise<boolean> {
        return Promise.resolve(true)
      },
    }
    const monitor = createSentryMonitor(sdk)
    expect(typeof monitor.captureException).toBe('function')
  })

  it('omits undefined members from scope contexts', () => {
    expect(toSentryScopeContext(undefined)).toBeUndefined()
    expect(toSentryScopeContext({ extra: { a: 1 } })).toEqual({ extra: { a: 1 } })
    expect(toSentryScopeContext(undefined, 'fatal')).toEqual({ level: 'fatal' })
  })
})

describe('buildRelease / parseRelease', () => {
  it('builds app@version+commit and round-trips', () => {
    const release = buildRelease({ app: 'earth-mobile', version: '1.4.0', commit: 'ABCDEF1234567' })
    expect(release).toBe('earth-mobile@1.4.0+abcdef1234567')
    expect(parseRelease(release)).toEqual({
      app: 'earth-mobile',
      version: '1.4.0',
      commit: 'abcdef1234567',
    })
  })

  it('omits the commit when there is none', () => {
    expect(buildRelease({ app: 'earth-web', version: '1.4.0-preview.2' })).toBe(
      'earth-web@1.4.0-preview.2',
    )
    expect(parseRelease('earth-web@1.4.0-preview.2')).toEqual({
      app: 'earth-web',
      version: '1.4.0-preview.2',
    })
  })

  it.each([
    [{ app: '', version: '1.0.0' }],
    [{ app: 'earth web', version: '1.0.0' }],
    [{ app: 'earth-web', version: '1.0.0+build' }],
    [{ app: 'earth-web', version: '1.0.0', commit: 'xyz' }],
    [{ app: 'earth-web', version: '1.0.0', commit: 'abc12' }],
    [{ app: 'a'.repeat(RELEASE_MAX_LENGTH), version: '1' }],
  ])('rejects %j', (parts) => {
    expect(() => buildRelease(parts)).toThrow(ReleaseFormatError)
  })

  it('returns null for strings it did not produce', () => {
    expect(parseRelease('earth-web')).toBeNull()
    expect(parseRelease('@1.0.0')).toBeNull()
    expect(parseRelease('earth-web@1.0.0+zzz')).toBeNull()
    expect(parseRelease('earth web@1.0.0')).toBeNull()
  })
})

describe('createSentryMonitor redaction', () => {
  it('redacts extra, tags, messages and breadcrumb data before they reach the SDK', () => {
    const sentry = fakeSentry()
    const monitor = createSentryMonitor(sentry, { now })

    monitor.captureException(new Error('boom'), {
      tags: { token: 't', route: 'rooms' },
      extra: { accessToken: 'x', url: 'https://x/?token=y', ok: 1 },
    })
    expect(sentry.captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { token: REDACTED_VALUE, route: 'rooms' },
      extra: { accessToken: REDACTED_VALUE, url: 'https://x/?token=[REDACTED]', ok: 1 },
    })

    monitor.captureMessage('failed: Bearer abc', 'error', { extra: { password: 'p' } })
    expect(sentry.captureMessage).toHaveBeenCalledWith('failed: Bearer [REDACTED]', {
      level: 'error',
      extra: { password: REDACTED_VALUE },
    })

    monitor.addBreadcrumb({
      category: 'http',
      message: 'call',
      data: { authorization: 'Bearer abc', status: 200 },
      timestampMs: 1000,
    })
    expect(sentry.addBreadcrumb).toHaveBeenCalledWith({
      category: 'http',
      message: 'call',
      data: { authorization: REDACTED_VALUE, status: 200 },
      timestamp: 1,
    })
  })

  it('redacts EarthError details attached as extra', () => {
    const sentry = fakeSentry()
    const error = new EarthError('invite_invalid', { details: { token: 'plain', groupId: 'g' } })
    createSentryMonitor(sentry).captureException(error)
    expect(sentry.captureException).toHaveBeenCalledWith(error, {
      tags: { [EARTH_ERROR_CODE_TAG]: 'invite_invalid' },
      extra: { [EARTH_ERROR_DETAILS_KEY]: { token: REDACTED_VALUE, groupId: 'g' } },
    })
  })

  it('replaces tag values under secret keys and keeps the rest', () => {
    expect(redactTags({ apiKey: 'k', route: 'rooms', attempt: 2 })).toEqual({
      apiKey: REDACTED_VALUE,
      route: 'rooms',
      attempt: 2,
    })
  })
})

describe('scrubException', () => {
  /** `fakeSentry` mocks are untyped; this spy keeps the SDK signature so calls can be inspected. */
  function spySentry() {
    const captureException = vi.fn<SentryLike['captureException']>(() => 'event-1')
    const sentry: SentryLike = { ...fakeSentry(), captureException }
    return { sentry, captureException }
  }

  it('forwards a clean error untouched, by identity', () => {
    const { sentry, captureException } = spySentry()
    const error = new EarthError('blocked', { details: { by: 'h' } })
    createSentryMonitor(sentry).captureException(error)
    expect(captureException.mock.calls[0]?.[0]).toBe(error)
    expect(scrubException('not an error')).toBe('not an error')
  })

  it('hands the SDK a same-prototype copy with scrubbed message and stack, keeping own props', () => {
    const { sentry, captureException } = spySentry()
    const cause = new Error('root')
    const error = new EarthError('internal', {
      message: 'signal wss://lk/rtc?access_token=abc.def refused',
      details: { roomId: 'r' },
      cause,
    })

    createSentryMonitor(sentry).captureException(error)

    const forwarded = captureException.mock.calls[0]?.[0] as EarthError
    expect(forwarded).not.toBe(error)
    expect(forwarded).toBeInstanceOf(EarthError)
    expect(forwarded.message).toBe('signal wss://lk/rtc?access_token=[REDACTED] refused')
    expect(forwarded.stack).toContain('access_token=[REDACTED]')
    expect(forwarded.stack).not.toContain('abc.def')
    expect(forwarded.name).toBe('EarthError')
    expect(forwarded.code).toBe('internal')
    expect(forwarded.details).toEqual({ roomId: 'r' })
    expect(forwarded.cause).toBe(cause)
    // The caller's error is never mutated.
    expect(error.message).toContain('abc.def')
    expect(captureException.mock.calls[0]?.[1]).toEqual({
      tags: { [EARTH_ERROR_CODE_TAG]: 'internal' },
      extra: { [EARTH_ERROR_DETAILS_KEY]: { roomId: 'r' } },
    })
  })
})
