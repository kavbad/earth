import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ANONYMOUS_VISITOR_ID_STORAGE_KEY,
  BASE_PROPERTY_KEYS,
  IDENTITY_PROPERTY_KEYS,
  RESERVED_PROPERTY_KEYS,
  createAnonymousVisitorId,
  createBaseProperties,
  createMemoryVisitorIdStorage,
  distinctIdFor,
  identityFromProperties,
  identityProperties,
  isAnonymousVisitorId,
  resolveAnonymousVisitorId,
} from './identity'

import type { GuestSessionId, HumanId } from '@earth/domain'

const HUMAN = '11111111-1111-4111-8111-111111111111' as HumanId
const GUEST = '22222222-2222-4222-8222-222222222222' as GuestSessionId

describe('createAnonymousVisitorId', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns a v4 uuid from crypto.randomUUID', () => {
    const id = createAnonymousVisitorId()
    expect(isAnonymousVisitorId(id)).toBe(true)
    expect(createAnonymousVisitorId()).not.toBe(id)
  })

  it('falls back to getRandomValues, then Math.random, when randomUUID is missing', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (array: Uint8Array) => {
        for (let i = 0; i < array.length; i += 1) array[i] = i * 17
        return array
      },
    })
    expect(isAnonymousVisitorId(createAnonymousVisitorId())).toBe(true)

    vi.stubGlobal('crypto', undefined)
    const id = createAnonymousVisitorId()
    expect(isAnonymousVisitorId(id)).toBe(true)
  })
})

describe('resolveAnonymousVisitorId', () => {
  it('creates and persists an id when storage is empty', async () => {
    const storage = createMemoryVisitorIdStorage()
    const id = await resolveAnonymousVisitorId({ storage })
    expect(isAnonymousVisitorId(id)).toBe(true)
    expect(storage.values.get(ANONYMOUS_VISITOR_ID_STORAGE_KEY)).toBe(id)
    expect(await resolveAnonymousVisitorId({ storage })).toBe(id)
  })

  it('replaces a malformed stored value', async () => {
    const storage = createMemoryVisitorIdStorage({ [ANONYMOUS_VISITOR_ID_STORAGE_KEY]: 'junk' })
    const generate = () => '33333333-3333-4333-8333-333333333333'
    expect(await resolveAnonymousVisitorId({ storage, generate })).toBe(generate())
    expect(storage.values.get(ANONYMOUS_VISITOR_ID_STORAGE_KEY)).toBe(generate())
  })

  it('supports async storage and survives storage failures', async () => {
    const values = new Map<string, string>()
    const asyncStorage = {
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => {
        values.set(key, value)
      },
    }
    const id = await resolveAnonymousVisitorId({ storage: asyncStorage, key: 'custom' })
    expect(values.get('custom')).toBe(id)

    const broken = {
      get: () => {
        throw new Error('no storage')
      },
      set: () => {
        throw new Error('no storage')
      },
    }
    expect(isAnonymousVisitorId(await resolveAnonymousVisitorId({ storage: broken }))).toBe(true)
  })
})

describe('identity helpers', () => {
  it('names the §96 identity and base keys exactly once each', () => {
    expect(IDENTITY_PROPERTY_KEYS).toEqual(['humanId', 'anonymousVisitorId', 'guestSessionId'])
    expect(BASE_PROPERTY_KEYS).toEqual(['appVersion', 'platform', 'timestamp'])
    expect(RESERVED_PROPERTY_KEYS).toEqual([...IDENTITY_PROPERTY_KEYS, ...BASE_PROPERTY_KEYS])
    expect(new Set(RESERVED_PROPERTY_KEYS).size).toBe(RESERVED_PROPERTY_KEYS.length)
  })

  it('prefers Human over Guest over Visitor for the distinct id', () => {
    expect(distinctIdFor({ humanId: HUMAN, guestSessionId: GUEST, anonymousVisitorId: 'v' })).toBe(
      HUMAN,
    )
    expect(distinctIdFor({ guestSessionId: GUEST, anonymousVisitorId: 'v' })).toBe(GUEST)
    expect(distinctIdFor({ anonymousVisitorId: 'v' })).toBe('v')
    expect(distinctIdFor({})).toBeUndefined()
  })

  it('round-trips identity through properties without undefined keys', () => {
    const props = identityProperties({ humanId: HUMAN, anonymousVisitorId: 'v' })
    expect(props).toEqual({ humanId: HUMAN, anonymousVisitorId: 'v' })
    expect(Object.keys(props)).not.toContain('guestSessionId')
    expect(identityFromProperties({ ...props, roomId: 'r', guestSessionId: 7 })).toEqual({
      humanId: HUMAN,
      anonymousVisitorId: 'v',
    })
  })

  it('stamps a fresh timestamp per call', () => {
    let tick = 1_700_000_000_000
    const base = createBaseProperties({ appVersion: '1.2.3', platform: 'ios', now: () => tick })
    expect(base()).toEqual({
      appVersion: '1.2.3',
      platform: 'ios',
      timestamp: '2023-11-14T22:13:20.000Z',
    })
    tick += 1000
    expect(base().timestamp).toBe('2023-11-14T22:13:21.000Z')
  })
})
