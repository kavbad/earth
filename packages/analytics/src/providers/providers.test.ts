import { describe, expect, it, vi } from 'vitest'

import type { AnalyticsEnvelope } from '../ingest'
import type { AnalyticsSink, AnalyticsSinkContext } from '../provider'
import { createConsoleProvider } from './console'
import { createNoopProvider } from './noop'
import {
  createPostHogNodeProvider,
  POSTHOG_PROCESS_PERSON_PROFILE_KEY,
  type PostHogNodeLike,
  SERVER_DISTINCT_ID,
} from './posthog-node'
import { createPostHogReactNativeProvider } from './posthog-react-native'
import { createPostHogWebProvider, type PostHogWebLike } from './posthog-web'
import { createSinkProvider } from './sink'

import type { GuestSessionId, HumanId } from '@earth/domain'

const HUMAN = '11111111-1111-4111-8111-111111111111' as HumanId
const GUEST = '22222222-2222-4222-8222-222222222222' as GuestSessionId

function fakeStatefulClient(): PostHogWebLike & {
  captures: unknown[][]
  identifies: unknown[][]
  resets: number
  flushes: number
} {
  const client = {
    captures: [] as unknown[][],
    identifies: [] as unknown[][],
    resets: 0,
    flushes: 0,
    capture(...args: unknown[]) {
      client.captures.push(args)
    },
    identify(...args: unknown[]) {
      client.identifies.push(args)
    },
    reset() {
      client.resets += 1
    },
    async flush() {
      client.flushes += 1
    },
  }
  return client
}

describe('noop and console providers', () => {
  it('noop accepts everything and flushes immediately', async () => {
    const noop = createNoopProvider()
    noop.identify({ humanId: HUMAN })
    noop.capture('feed_opened', { scope: 'world' })
    noop.reset()
    await expect(noop.flush?.()).resolves.toBeUndefined()
  })

  it('console logs through the injected logger', () => {
    const log = vi.fn()
    const provider = createConsoleProvider({ log })
    provider.identify({ humanId: HUMAN })
    provider.capture('feed_opened', { scope: 'world' })
    provider.reset()
    expect(log.mock.calls).toEqual([
      ['[analytics] identify', { humanId: HUMAN }],
      ['[analytics] feed_opened', { scope: 'world' }],
      ['[analytics] reset'],
    ])
  })
})

describe('PostHog stateful adapters (web, react-native)', () => {
  it.each([
    ['web', createPostHogWebProvider, 'posthog-web'],
    ['react-native', createPostHogReactNativeProvider, 'posthog-react-native'],
  ] as const)('%s forwards to the injected client', async (_label, factory, name) => {
    const client = fakeStatefulClient()
    const provider = factory(client)
    expect(provider.name).toBe(name)

    provider.identify({ anonymousVisitorId: 'v' })
    expect(client.identifies).toHaveLength(0) // Visitors are not identified

    provider.identify({ guestSessionId: GUEST, anonymousVisitorId: 'v' })
    provider.identify({ humanId: HUMAN, guestSessionId: GUEST, anonymousVisitorId: 'v' })
    expect(client.identifies).toEqual([
      [GUEST, { guestSessionId: GUEST, anonymousVisitorId: 'v' }],
      [HUMAN, { humanId: HUMAN, guestSessionId: GUEST, anonymousVisitorId: 'v' }],
    ])

    provider.capture('room_joined', { roomId: 'r', humanId: HUMAN })
    expect(client.captures).toEqual([['room_joined', { roomId: 'r', humanId: HUMAN }]])

    provider.reset()
    await provider.flush?.()
    expect(client.resets).toBe(1)
    expect(client.flushes).toBe(1)
  })

  it('tolerates a client without flush()', async () => {
    const client = fakeStatefulClient()
    const minimal: PostHogWebLike = {
      capture: client.capture,
      identify: client.identify,
      reset: client.reset,
    }
    await expect(createPostHogWebProvider(minimal).flush?.()).resolves.toBeUndefined()
  })
})

describe('PostHog node adapter', () => {
  it('derives the distinct id per event and passes the event timestamp', async () => {
    const messages: unknown[] = []
    const client: PostHogNodeLike = {
      capture: (message) => messages.push(['capture', message]),
      identify: (message) => messages.push(['identify', message]),
      flush: async () => messages.push(['flush']),
    }
    const provider = createPostHogNodeProvider(client)

    provider.identify({ anonymousVisitorId: 'v' })
    provider.identify({ humanId: HUMAN })
    provider.capture('room_joined', {
      roomId: 'r',
      humanId: HUMAN,
      timestamp: '2026-09-03T10:00:00.000Z',
    })
    provider.capture('guest_joined', {
      roomId: 'r',
      guestSessionId: GUEST,
      anonymousVisitorId: 'v',
    })
    provider.capture('room_left', { roomId: 'r', timestamp: 'not-a-date' })
    provider.reset()
    await provider.flush?.()

    expect(messages).toEqual([
      ['identify', { distinctId: HUMAN, properties: { humanId: HUMAN } }],
      [
        'capture',
        {
          distinctId: HUMAN,
          event: 'room_joined',
          properties: { roomId: 'r', humanId: HUMAN, timestamp: '2026-09-03T10:00:00.000Z' },
          timestamp: new Date('2026-09-03T10:00:00.000Z'),
        },
      ],
      [
        'capture',
        {
          distinctId: GUEST,
          event: 'guest_joined',
          properties: { roomId: 'r', guestSessionId: GUEST, anonymousVisitorId: 'v' },
        },
      ],
      [
        'capture',
        {
          distinctId: SERVER_DISTINCT_ID,
          event: 'room_left',
          properties: {
            roomId: 'r',
            timestamp: 'not-a-date',
            [POSTHOG_PROCESS_PERSON_PROFILE_KEY]: false,
          },
        },
      ],
      ['flush'],
    ])
  })

  it('does not mint person profiles for Visitor events but does for Guests and Humans', () => {
    const messages: { distinctId: string; properties?: Record<string, unknown> }[] = []
    const provider = createPostHogNodeProvider({
      capture: (message) => messages.push(message),
      identify: () => undefined,
      flush: async () => undefined,
    })
    provider.capture('public_world_viewed', { anonymousVisitorId: 'v', scope: 'world' })
    provider.capture('guest_joined', { guestSessionId: GUEST, anonymousVisitorId: 'v' })
    provider.capture('feed_opened', { humanId: HUMAN, anonymousVisitorId: 'v' })
    expect(
      messages.map((m) => [m.distinctId, m.properties?.[POSTHOG_PROCESS_PERSON_PROFILE_KEY]]),
    ).toEqual([
      ['v', false],
      [GUEST, undefined],
      [HUMAN, undefined],
    ])
    expect(POSTHOG_PROCESS_PERSON_PROFILE_KEY).toBe('$process_person_profile')
  })
})

describe('sink provider', () => {
  it('hands each event to the sink with a receivedAt context', async () => {
    const received: [readonly AnalyticsEnvelope[], AnalyticsSinkContext][] = []
    const sink: AnalyticsSink = {
      ingest: async (events, context) => {
        received.push([events, context])
      },
    }
    const provider = createSinkProvider({ sink, now: () => Date.UTC(2026, 8, 3, 10) })
    await provider.capture('human_claimed', { humanId: HUMAN, intent: 'start_group' })
    expect(received).toEqual([
      [
        [{ name: 'human_claimed', properties: { humanId: HUMAN, intent: 'start_group' } }],
        { receivedAt: '2026-09-03T10:00:00.000Z' },
      ],
    ])
  })
})
