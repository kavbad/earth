import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { arrayOrKeyed } from './schemas'

const Item = z.object({ id: z.int() })
const Items = arrayOrKeyed(Item, 'items')

describe('arrayOrKeyed', () => {
  it('accepts a bare array, a keyed object and the empty forms', () => {
    expect(Items.parse([{ id: 1 }, { id: 2 }])).toEqual([{ id: 1 }, { id: 2 }])
    expect(Items.parse({ items: [{ id: 3 }] })).toEqual([{ id: 3 }])
    expect(Items.parse([])).toEqual([])
    expect(Items.parse({ items: [] })).toEqual([])
    expect(Items.parse({ items: null })).toEqual([])
    expect(Items.parse({})).toEqual([])
    expect(Items.parse(null)).toEqual([])
  })

  it('strips unknown keys of the items and keeps the array order', () => {
    expect(Items.parse([{ id: 2, extra: 'x' }, { id: 1 }])).toEqual([{ id: 2 }, { id: 1 }])
  })

  it('still rejects malformed items and unrelated shapes', () => {
    expect(Items.safeParse([{ id: 'one' }]).success).toBe(false)
    expect(Items.safeParse({ items: [{ id: 'one' }] }).success).toBe(false)
    expect(Items.safeParse({ items: 'nope' }).success).toBe(false)
    expect(Items.safeParse('nope').success).toBe(false)
    expect(Items.safeParse(undefined).success).toBe(false)
    expect(Items.safeParse(42).success).toBe(false)
  })
})
