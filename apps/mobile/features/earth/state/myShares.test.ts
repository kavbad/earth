import { describe, expect, it } from 'vitest'

import { createMemoryStorage } from '../storage'
import {
  type MyShare,
  addMyShare,
  mySharesKey,
  nextExpiry,
  readMyShares,
  removeMyShare,
  sharesNeedingUpdates,
  writeMyShares,
} from './myShares'

const HUMAN = '11111111-1111-4111-8111-111111111111'
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

describe('my shares (device memory of own shares)', () => {
  it('round-trips active shares and drops expired ones', async () => {
    const storage = createMemoryStorage()
    await writeMyShares(storage, HUMAN, [
      share(),
      share({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', expiresAt: '2026-09-03T17:00:00.000Z' }),
    ])
    expect(storage.values.has(mySharesKey(HUMAN))).toBe(true)
    expect((await readMyShares(storage, HUMAN, NOW)).map((s) => s.id)).toEqual([share().id])
  })

  it('reads malformed storage as nothing', async () => {
    const storage = createMemoryStorage({ [mySharesKey(HUMAN)]: '{"nope":1}' })
    expect(await readMyShares(storage, HUMAN, NOW)).toEqual([])
    expect(await readMyShares(null, HUMAN, NOW)).toEqual([])
  })

  it('replaces a share to the same audience and removes by id', () => {
    const first = share()
    const again = share({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', precision: 'precise' })
    const list = addMyShare([first], again)
    expect(list).toEqual([again])
    expect(removeMyShare(list, again.id)).toEqual([])
  })

  it('only approximate and precise shares need position updates', () => {
    const city = share({ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', precision: 'city' })
    expect(sharesNeedingUpdates([share(), city], NOW).map((s) => s.id)).toEqual([share().id])
  })

  it('knows when the next share ends so the updater can stop on its own', () => {
    const later = share({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      expiresAt: '2026-09-03T20:00:00.000Z',
    })
    expect(nextExpiry([share(), later], NOW)).toBe(Date.parse('2026-09-03T19:00:00.000Z'))
    expect(nextExpiry([], NOW)).toBeNull()
    expect(nextExpiry([share()], Date.parse('2026-09-03T19:00:00Z'))).toBeNull()
  })
})
