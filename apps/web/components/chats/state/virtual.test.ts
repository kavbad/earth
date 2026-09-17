import { describe, expect, it } from 'vitest'

import { anchorDelta, buildLayout, isNearBottom, rowAt, visibleRange } from './virtual'

const keys = ['a', 'b', 'c', 'd', 'e']

describe('buildLayout', () => {
  it('uses measured heights where known and the estimate elsewhere', () => {
    const layout = buildLayout(
      keys,
      new Map([
        ['b', 100],
        ['d', 0],
      ]),
      40,
    )
    expect(layout.offsets).toEqual([0, 40, 140, 180, 220, 260])
    expect(layout.total).toBe(260)
  })

  it('is empty for no rows', () => {
    expect(buildLayout([], new Map(), 40)).toEqual({ offsets: [0], total: 0 })
  })
})

describe('rowAt / visibleRange', () => {
  const layout = buildLayout(keys, new Map([['b', 100]]), 40)

  it('finds the row containing a y position', () => {
    expect(rowAt(layout, 0)).toBe(0)
    expect(rowAt(layout, 39)).toBe(0)
    expect(rowAt(layout, 40)).toBe(1)
    expect(rowAt(layout, 139)).toBe(1)
    expect(rowAt(layout, 1000)).toBe(4)
  })

  it('windows rows to the viewport plus overscan and clamps at the ends', () => {
    expect(visibleRange(layout, 0, 50, 0)).toEqual({ start: 0, end: 2 })
    expect(visibleRange(layout, 150, 50, 0)).toEqual({ start: 2, end: 4 })
    expect(visibleRange(layout, 150, 50, 100)).toEqual({ start: 1, end: 5 })
    expect(visibleRange(layout, 5000, 50, 0)).toEqual({ start: 4, end: 5 })
    expect(visibleRange({ offsets: [0], total: 0 }, 0, 50, 0)).toEqual({ start: 0, end: 0 })
  })
})

describe('anchorDelta (keep scroll position on prepend)', () => {
  it('measures how far the anchor row moved when older rows were inserted above it', () => {
    const before = buildLayout(['c', 'd'], new Map(), 40)
    const after = buildLayout(['a', 'b', 'c', 'd'], new Map([['a', 60]]), 40)
    expect(anchorDelta(['c', 'd'], before, ['a', 'b', 'c', 'd'], after, 'c')).toBe(100)
    expect(anchorDelta(['c', 'd'], before, ['a', 'b', 'c', 'd'], after, 'zzz')).toBe(0)
  })
})

describe('isNearBottom', () => {
  it('is true within the threshold of the end', () => {
    expect(isNearBottom(900, 100, 1000, 0)).toBe(true)
    expect(isNearBottom(850, 100, 1000, 80)).toBe(true)
    expect(isNearBottom(700, 100, 1000, 80)).toBe(false)
  })
})
