import { describe, expect, it, vi } from 'vitest'

import {
  AnalyticsContractError,
  type AnalyticsProviderFailure,
  createAnalytics,
  isDevelopmentRuntime,
  mergeEventProperties,
} from './client'
import type { EventName } from './contract'
import type { AnalyticsIdentity, BaseProperties } from './identity'
import type { AnalyticsProperties, AnalyticsProvider } from './provider'

import type { GuestSessionId, HumanId, RoomId } from '@earth/domain'

const HUMAN = '11111111-1111-4111-8111-111111111111' as HumanId
const GUEST = '22222222-2222-4222-8222-222222222222' as GuestSessionId
const ROOM = '33333333-3333-4333-8333-333333333333' as RoomId

const BASE: BaseProperties = {
  appVersion: '1.0.0',
  platform: 'web',
  timestamp: '2026-09-03T10:00:00.000Z',
}

interface Recorded {
  captures: { name: EventName; properties: AnalyticsProperties }[]
  identities: AnalyticsIdentity[]
  resets: number
  flushes: number
}

function recordingProvider(name: string): AnalyticsProvider & { recorded: Recorded } {
  const recorded: Recorded = { captures: [], identities: [], resets: 0, flushes: 0 }
  return {
    name,
    recorded,
    identify: (identity) => {
      recorded.identities.push(identity)
    },
    capture: (eventName, properties) => {
      recorded.captures.push({ name: eventName, properties })
    },
    reset: () => {
      recorded.resets += 1
    },
    flush: async () => {
      recorded.flushes += 1
    },
  }
}

describe('createAnalytics', () => {
  it('merges base + identity + event properties and fans out to every provider', () => {
    const a = recordingProvider('a')
    const b = recordingProvider('b')
    const analytics = createAnalytics({
      providers: [a, b],
      base: () => BASE,
      identity: () => ({ humanId: HUMAN, anonymousVisitorId: 'visitor-1' }),
      onForbiddenProperty: 'throw',
    })

    analytics.track('scope_changed', { from: 'friends', to: 'city', surface: 'home' })

    const expected = {
      appVersion: '1.0.0',
      platform: 'web',
      timestamp: '2026-09-03T10:00:00.000Z',
      humanId: HUMAN,
      anonymousVisitorId: 'visitor-1',
      from: 'friends',
      to: 'city',
      surface: 'home',
    }
    expect(a.recorded.captures).toEqual([{ name: 'scope_changed', properties: expected }])
    expect(b.recorded.captures).toEqual([{ name: 'scope_changed', properties: expected }])
    expect(Object.keys(expected)).not.toContain('guestSessionId')
  })

  it('lets event properties win over identity for the same key and drops undefined values', () => {
    const p = recordingProvider('p')
    const analytics = createAnalytics({
      providers: [p],
      base: () => BASE,
      identity: () => ({ humanId: HUMAN, guestSessionId: GUEST }),
      onForbiddenProperty: 'throw',
    })
    const removedGuest = '44444444-4444-4444-8444-444444444444' as GuestSessionId
    analytics.track('guest_removed', { roomId: ROOM, guestSessionId: removedGuest })
    // Explicit undefined is a type error under exactOptionalPropertyTypes; simulate a loose caller.
    const loose = analytics.track as (name: EventName, props: Record<string, unknown>) => void
    loose('claim_group_join_selected', { groupId: undefined })

    expect(p.recorded.captures[0]?.properties).toMatchObject({
      humanId: HUMAN,
      guestSessionId: removedGuest,
      roomId: ROOM,
    })
    expect(Object.keys(p.recorded.captures[1]?.properties ?? {})).not.toContain('groupId')
  })

  it('throws AnalyticsContractError on GPS properties in throw mode', () => {
    const p = recordingProvider('p')
    const analytics = createAnalytics({
      providers: [p],
      base: () => BASE,
      identity: () => ({}),
      onForbiddenProperty: 'throw',
    })
    // The contract has no GPS keys, so an untyped caller is the only way to smuggle them in.
    const track = analytics.track as (name: EventName, props: Record<string, unknown>) => void
    expect(() => track('room_joined', { roomId: ROOM, lat: 1, userLng: 2 })).toThrow(
      AnalyticsContractError,
    )
    try {
      track('room_joined', { roomId: ROOM, lat: 1, userLng: 2 })
    } catch (error) {
      expect(error).toBeInstanceOf(AnalyticsContractError)
      expect((error as AnalyticsContractError).code).toBe('forbidden_property')
      expect((error as AnalyticsContractError).keys).toEqual(['lat', 'userLng'])
    }
    expect(p.recorded.captures).toHaveLength(0)
  })

  it('strips GPS properties in strip mode and still delivers the event', () => {
    const p = recordingProvider('p')
    const analytics = createAnalytics({
      providers: [p],
      base: () => BASE,
      identity: () => ({ anonymousVisitorId: 'v' }),
      onForbiddenProperty: 'strip',
    })
    const track = analytics.track as (name: EventName, props: Record<string, unknown>) => void
    track('post_created', { postId: 'p1', audience: 'world', latitude: 1, coords: [1, 2] })
    expect(p.recorded.captures).toEqual([
      {
        name: 'post_created',
        properties: { ...BASE, anonymousVisitorId: 'v', postId: 'p1', audience: 'world' },
      },
    ])
  })

  it('strips coordinate-like values (not just keys) in strip mode', () => {
    const p = recordingProvider('p')
    const analytics = createAnalytics({
      providers: [p],
      base: () => BASE,
      identity: () => ({}),
      onForbiddenProperty: 'strip',
    })
    const track = analytics.track as (name: EventName, props: Record<string, unknown>) => void
    track('post_created', { postId: 'p1', audience: 'world', area: '37.7749,-122.4194' })
    expect(p.recorded.captures[0]?.properties).toEqual({ ...BASE, postId: 'p1', audience: 'world' })
  })

  it('rejects unknown event names (throw) or drops them (strip)', () => {
    const p = recordingProvider('p')
    const make = (mode: 'throw' | 'strip') =>
      createAnalytics({
        providers: [p],
        base: () => BASE,
        identity: () => ({}),
        onForbiddenProperty: mode,
      }).track as (name: string, props: Record<string, unknown>) => void
    expect(() => make('throw')('page_view', {})).toThrow(AnalyticsContractError)
    make('strip')('page_view', {})
    expect(p.recorded.captures).toHaveLength(0)
  })

  it('isolates provider failures (sync and async) and reports them', async () => {
    const failures: AnalyticsProviderFailure[] = []
    const good = recordingProvider('good')
    const bad: AnalyticsProvider = {
      name: 'bad',
      identify: () => {
        throw new Error('identify boom')
      },
      capture: () => Promise.reject(new Error('capture boom')),
      reset: () => undefined,
      flush: () => Promise.reject(new Error('flush boom')),
    }
    const analytics = createAnalytics({
      providers: [bad, good],
      base: () => BASE,
      identity: () => ({ humanId: HUMAN }),
      onForbiddenProperty: 'throw',
      onError: (failure) => failures.push(failure),
    })

    expect(() => analytics.identify()).not.toThrow()
    analytics.track('feed_opened', { scope: 'world', surface: 'home', source: 'launch' })
    await analytics.flush()
    await Promise.resolve()

    expect(good.recorded.identities).toEqual([{ humanId: HUMAN }])
    expect(good.recorded.captures).toHaveLength(1)
    expect(good.recorded.flushes).toBe(1)
    expect(failures.map((f) => [f.provider, f.operation, f.event])).toEqual([
      ['bad', 'identify', undefined],
      ['bad', 'capture', 'feed_opened'],
      ['bad', 'flush', undefined],
    ])
  })

  it('reports rejections from non-native thenables instead of leaking unhandled rejections', async () => {
    const failures: AnalyticsProviderFailure[] = []
    const rejectingThenable = {
      then(_onFulfilled: unknown, onRejected: (error: unknown) => void) {
        onRejected(new Error('thenable boom'))
      },
    }
    const provider: AnalyticsProvider = {
      name: 'thenable',
      identify: () => undefined,
      capture: () => rejectingThenable as unknown as Promise<void>,
      reset: () => undefined,
      flush: () => rejectingThenable as unknown as Promise<void>,
    }
    const analytics = createAnalytics({
      providers: [provider],
      base: () => BASE,
      identity: () => ({}),
      onForbiddenProperty: 'throw',
      onError: (failure) => failures.push(failure),
    })
    analytics.track('claim_group_start_selected', {})
    await analytics.flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(failures.map((f) => [f.operation, (f.error as Error).message])).toEqual([
      ['capture', 'thenable boom'],
      ['flush', 'thenable boom'],
    ])
  })

  it('identify() accepts an explicit identity and reset() reaches every provider', () => {
    const a = recordingProvider('a')
    const b = recordingProvider('b')
    const analytics = createAnalytics({
      providers: [a, b],
      base: () => BASE,
      identity: () => ({ anonymousVisitorId: 'v' }),
      onForbiddenProperty: 'throw',
    })
    analytics.identify({ guestSessionId: GUEST })
    analytics.reset()
    expect(a.recorded.identities).toEqual([{ guestSessionId: GUEST }])
    expect(b.recorded.identities).toEqual([{ guestSessionId: GUEST }])
    expect(a.recorded.resets + b.recorded.resets).toBe(2)
  })

  it('defaults the guard mode from the runtime', () => {
    const onError = vi.fn()
    const analytics = createAnalytics({
      providers: [],
      base: () => BASE,
      identity: () => ({}),
      onError,
    })
    // vitest runs with NODE_ENV=test → development semantics → throw.
    expect(isDevelopmentRuntime()).toBe(true)
    const track = analytics.track as (name: EventName, props: Record<string, unknown>) => void
    expect(() => track('search_performed', { queryLength: 1, resultCount: 0, lat: 0 })).toThrow()
    expect(onError).not.toHaveBeenCalled()
  })

  it('mergeEventProperties is exported for server-side use', () => {
    expect(mergeEventProperties(BASE, { humanId: HUMAN }, { roomId: ROOM })).toEqual({
      ...BASE,
      humanId: HUMAN,
      roomId: ROOM,
    })
  })
})
