import type { HumanId } from '@earth/domain'
import { type SentryLike, createLogger } from '@earth/observability'
import { describe, expect, it, vi } from 'vitest'

import { mobileRelease, monitorIdentityFor, selectErrorMonitor } from './setup'

const HUMAN = '11111111-1111-4111-8111-111111111111' as HumanId

interface FakeSentry {
  readonly sentry: SentryLike
  readonly captureException: ReturnType<typeof vi.fn<(exception: unknown) => void>>
  readonly setTag: ReturnType<typeof vi.fn<(key: string, value: string) => void>>
}

function fakeSentry(): FakeSentry {
  const captureException = vi.fn<(exception: unknown) => void>()
  const setTag = vi.fn<(key: string, value: string) => void>()
  const sentry: SentryLike = {
    captureException,
    captureMessage: () => undefined,
    setUser: () => undefined,
    addBreadcrumb: () => undefined,
    setTag,
  }
  return { sentry, captureException, setTag }
}

const quiet = createLogger({ sink: () => undefined })

describe('selectErrorMonitor', () => {
  it('reports to Sentry when a DSN and the SDK are present', () => {
    const fake = fakeSentry()
    const monitor = selectErrorMonitor({
      dsn: 'https://key@sentry.io/1',
      sentry: fake.sentry,
      release: 'earth-mobile@0.1.0',
      isDevelopment: false,
    })
    monitor.captureException(new Error('boom'))
    expect(fake.captureException).toHaveBeenCalledTimes(1)
    expect(fake.setTag).toHaveBeenCalledWith('earth.release', 'earth-mobile@0.1.0')
  })

  it('ignores the SDK without a DSN and never crashes the app', () => {
    const fake = fakeSentry()
    const monitor = selectErrorMonitor({
      dsn: undefined,
      sentry: fake.sentry,
      release: 'earth-mobile@0.1.0',
      isDevelopment: false,
      logger: quiet,
    })
    monitor.captureException(new Error('boom'))
    expect(fake.captureException).not.toHaveBeenCalled()
  })

  it('writes to the structured console in development', () => {
    const lines: string[] = []
    const monitor = selectErrorMonitor({
      dsn: undefined,
      sentry: null,
      release: 'earth-mobile@0.1.0',
      isDevelopment: true,
      logger: createLogger({ sink: (line) => lines.push(line) }),
    })
    monitor.captureException(new Error('boom'))
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join('\n')).toContain('boom')
  })
})

describe('release and identity', () => {
  it('names the release after the app and version', () => {
    expect(mobileRelease('0.1.0')).toBe('earth-mobile@0.1.0')
    expect(mobileRelease('0.1.0', 'abcdef1')).toBe('earth-mobile@0.1.0+abcdef1')
  })

  it('identifies a Human by id and public handle only', () => {
    expect(monitorIdentityFor({ humanId: null, identity: null })).toBeNull()
    expect(monitorIdentityFor({ humanId: HUMAN, identity: null })).toEqual({
      kind: 'human',
      id: HUMAN,
    })
    expect(monitorIdentityFor({ humanId: HUMAN, identity: { handle: 'maya' } })).toEqual({
      kind: 'human',
      id: HUMAN,
      handle: 'maya',
    })
  })
})
