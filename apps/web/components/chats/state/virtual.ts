/**
 * Windowing math for the message list (spec §131 "performant lists"): rows have measured heights
 * once rendered and an estimate before that; only the rows intersecting the viewport (plus an
 * overscan) are mounted. Pure so the arithmetic is unit-tested; `MessageList` owns the DOM.
 */

export interface VirtualLayout {
  /** `offsets[i]` is the top of row `i`; `offsets[n]` (= `total`) the bottom of the last row. */
  readonly offsets: readonly number[]
  readonly total: number
}

export interface VirtualRange {
  readonly start: number
  /** Exclusive. */
  readonly end: number
}

export const EMPTY_LAYOUT: VirtualLayout = { offsets: [0], total: 0 }

export function buildLayout(
  keys: readonly string[],
  heights: ReadonlyMap<string, number>,
  estimate: number,
): VirtualLayout {
  const offsets: number[] = new Array<number>(keys.length + 1)
  let top = 0
  for (let index = 0; index < keys.length; index += 1) {
    offsets[index] = top
    const key = keys[index]
    const measured = key === undefined ? undefined : heights.get(key)
    top += measured !== undefined && measured > 0 ? measured : estimate
  }
  offsets[keys.length] = top
  return { offsets, total: top }
}

/** Index of the last row whose top is at or above `y` (binary search over `offsets`). */
export function rowAt(layout: VirtualLayout, y: number): number {
  const count = layout.offsets.length - 1
  if (count <= 0) return 0
  let low = 0
  let high = count - 1
  while (low < high) {
    const mid = (low + high + 1) >>> 1
    const offset = layout.offsets[mid] ?? 0
    if (offset <= y) low = mid
    else high = mid - 1
  }
  return low
}

/** Rows to mount for a viewport `[scrollTop, scrollTop + viewportHeight]` plus `overscan` px. */
export function visibleRange(
  layout: VirtualLayout,
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): VirtualRange {
  const count = layout.offsets.length - 1
  if (count <= 0) return { start: 0, end: 0 }
  const top = Math.max(0, scrollTop - overscan)
  const bottom = scrollTop + viewportHeight + overscan
  const start = rowAt(layout, top)
  let end = rowAt(layout, bottom) + 1
  if (end > count) end = count
  return { start, end: Math.max(end, start) }
}

/**
 * How far the viewport must move after rows were inserted above `anchorKey` so the anchor keeps
 * its on-screen position (spec: "keep scroll position on prepend"). `0` when the anchor is gone.
 */
export function anchorDelta(
  previousKeys: readonly string[],
  previousLayout: VirtualLayout,
  nextKeys: readonly string[],
  nextLayout: VirtualLayout,
  anchorKey: string,
): number {
  const previousIndex = previousKeys.indexOf(anchorKey)
  const nextIndex = nextKeys.indexOf(anchorKey)
  if (previousIndex < 0 || nextIndex < 0) return 0
  const previousTop = previousLayout.offsets[previousIndex] ?? 0
  const nextTop = nextLayout.offsets[nextIndex] ?? 0
  return nextTop - previousTop
}

/** Whether a viewport is within `threshold` px of the bottom of `total`. */
export function isNearBottom(
  scrollTop: number,
  viewportHeight: number,
  total: number,
  threshold: number,
): boolean {
  return total - (scrollTop + viewportHeight) <= threshold
}
