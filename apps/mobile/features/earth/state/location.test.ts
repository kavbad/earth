import { describe, expect, it } from 'vitest'

import { mapCopy } from '../copy'
import {
  LOCATION_ACCURACY,
  type LocationLike,
  SHARE_UPDATE_INTERVAL_MS,
  accuracyForPrecision,
  accuracyForShares,
  messageForFailure,
  requestPosition,
  watchPlan,
} from './location'
import type { MyShare } from './myShares'

const NOW = Date.parse('2026-09-03T18:00:00Z')

function share(overrides: Partial<MyShare> = {}): MyShare {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    audienceType: 'group',
    audienceId: '44444444-4444-4444-8444-444444444444',
    audienceName: 'Weekend Crew',
    precision: 'approximate',
    expiresAt: '2026-09-03T19:00:00.000Z',
    createdAt: '2026-09-03T18:00:00.000Z',
    ...overrides,
  }
}

function fakeLocation(input: {
  status: 'granted' | 'undetermined' | 'denied'
  grantOnRequest?: boolean
  position?: { latitude: number; longitude: number }
  fail?: boolean
}): LocationLike & { asked: unknown[]; requested: number } {
  const state = { asked: [] as unknown[], requested: 0 }
  return {
    ...state,
    async getForegroundPermissionsAsync() {
      return {
        status: input.status,
        granted: input.status === 'granted',
        canAskAgain: input.status !== 'denied',
      }
    },
    async requestForegroundPermissionsAsync() {
      state.requested += 1
      const granted = input.grantOnRequest === true
      return { status: granted ? 'granted' : 'denied', granted, canAskAgain: false }
    },
    async getCurrentPositionAsync(options) {
      state.asked.push(options)
      if (input.fail === true) throw new Error('no fix')
      return { coords: input.position ?? { latitude: 37.76, longitude: -122.42 } }
    },
    get asked() {
      return state.asked
    },
    get requested() {
      return state.requested
    },
  }
}

describe('requestPosition (spec §74: explicit, one-shot, when-in-use)', () => {
  it('resolves the coordinates once and asks for low accuracy by default', async () => {
    const geo = fakeLocation({ status: 'granted' })
    await expect(requestPosition(geo)).resolves.toEqual({
      ok: true,
      position: { lat: 37.76, lng: -122.42 },
    })
    expect(geo.asked).toEqual([{ accuracy: LOCATION_ACCURACY.low }])
    expect(geo.requested).toBe(0)
  })

  it('asks the system once when undetermined and reports a denial', async () => {
    const granted = fakeLocation({ status: 'undetermined', grantOnRequest: true })
    await expect(requestPosition(granted)).resolves.toMatchObject({ ok: true })
    expect(granted.requested).toBe(1)
    const denied = fakeLocation({ status: 'undetermined', grantOnRequest: false })
    await expect(requestPosition(denied)).resolves.toEqual({ ok: false, failure: 'denied' })
    const never = fakeLocation({ status: 'denied' })
    await expect(requestPosition(never)).resolves.toEqual({ ok: false, failure: 'denied' })
    expect(never.requested).toBe(0)
  })

  it('does not ask when told not to (background refreshes never prompt)', async () => {
    const geo = fakeLocation({ status: 'undetermined', grantOnRequest: true })
    await expect(requestPosition(geo, { requestPermission: false })).resolves.toEqual({
      ok: false,
      failure: 'denied',
    })
    expect(geo.requested).toBe(0)
  })

  it('maps a missing module, a failed fix and a timeout', async () => {
    await expect(requestPosition(null)).resolves.toEqual({ ok: false, failure: 'unsupported' })
    await expect(requestPosition(fakeLocation({ status: 'granted', fail: true }))).resolves.toEqual(
      {
        ok: false,
        failure: 'unavailable',
      },
    )
    const slow: LocationLike = {
      ...fakeLocation({ status: 'granted' }),
      getCurrentPositionAsync: () => new Promise(() => undefined),
    }
    await expect(requestPosition(slow, { timeoutMs: 5 })).resolves.toEqual({
      ok: false,
      failure: 'timeout',
    })
  })

  it('reads a precise position only for a precise share', async () => {
    const geo = fakeLocation({ status: 'granted' })
    await requestPosition(geo, { precision: 'precise' })
    await requestPosition(geo, { precision: 'approximate' })
    await requestPosition(geo, { precision: 'city' })
    expect(geo.asked).toEqual([
      { accuracy: LOCATION_ACCURACY.high },
      { accuracy: LOCATION_ACCURACY.balanced },
      { accuracy: LOCATION_ACCURACY.low },
    ])
    expect(accuracyForPrecision(null)).toBe(LOCATION_ACCURACY.low)
  })

  it('explains each failure in the map copy', () => {
    expect(messageForFailure('denied')).toBe(mapCopy.locationDenied)
    expect(messageForFailure('unsupported')).toBe(mapCopy.locationUnsupported)
    expect(messageForFailure('timeout')).toBe(mapCopy.locationUnavailable)
  })
})

describe('watchPlan (periodic updates while foregrounded)', () => {
  it('watches only while in front, only for shares that carry a position, until the soonest ends', () => {
    const precise = share({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      precision: 'precise',
      expiresAt: '2026-09-03T18:30:00.000Z',
    })
    const city = share({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', precision: 'city' })
    const plan = watchPlan([share(), precise, city], NOW, true)
    expect(plan).not.toBeNull()
    expect(plan!.shareIds).toEqual([share().id, precise.id])
    expect(plan!.accuracy).toBe(LOCATION_ACCURACY.high)
    expect(plan!.timeInterval).toBe(SHARE_UPDATE_INTERVAL_MS)
    expect(plan!.until).toBe(Date.parse('2026-09-03T18:30:00Z'))
  })

  it('stops in the background, after revoke and after expiry', () => {
    expect(watchPlan([share()], NOW, false)).toBeNull()
    expect(watchPlan([], NOW, true)).toBeNull()
    expect(watchPlan([share()], Date.parse('2026-09-03T19:00:00Z'), true)).toBeNull()
    expect(watchPlan([share({ precision: 'city' })], NOW, true)).toBeNull()
  })

  it('needs only balanced accuracy for approximate shares', () => {
    expect(accuracyForShares([share()])).toBe(LOCATION_ACCURACY.balanced)
    expect(accuracyForShares([share({ precision: 'city' })])).toBe(LOCATION_ACCURACY.low)
  })
})
