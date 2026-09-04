import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { STYLE_READY_TIMEOUT_MS, type StyleReadySource, whenStyleReady } from './styleReady'

/** A map whose style has not settled: it records handlers and fires them only when told to. */
function pendingMap(): StyleReadySource & { fire: (event: 'load' | 'error') => void } {
  const handlers = new Map<string, () => void>()
  return {
    loaded: () => false,
    once: (event, handler) => handlers.set(event, handler),
    fire: (event) => handlers.get(event)?.(),
  }
}

/** Resolved yet? Races the promise against a marker that settles on the next microtask queue. */
async function settled(promise: Promise<void>): Promise<boolean> {
  const pending = Symbol('pending')
  return (await Promise.race([promise.then(() => true), Promise.resolve(pending)])) !== pending
}

describe('whenStyleReady', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is already ready when the style is loaded', async () => {
    const map: StyleReadySource = { loaded: () => true, once: () => undefined }
    await expect(whenStyleReady(map)).resolves.toBeUndefined()
  })

  it('waits for the style, then goes on `load`', async () => {
    const map = pendingMap()
    const ready = whenStyleReady(map)
    expect(await settled(ready)).toBe(false)
    map.fire('load')
    await expect(ready).resolves.toBeUndefined()
  })

  it('goes on `error` too: a style that fails still leaves a usable, blank map', async () => {
    const map = pendingMap()
    const ready = whenStyleReady(map)
    map.fire('error')
    await expect(ready).resolves.toBeUndefined()
  })

  it('goes anyway once the deadline passes: a style host that never answers must not hang the map', async () => {
    // The regression this pins: waiting on `load`/`error` alone waits forever behind a style host
    // that accepts the request and never replies, so the map is never handed over, `map_objects` is
    // never asked for, and Earth shows no one (E2E 10 — Block failed exactly here).
    const map = pendingMap()
    const ready = whenStyleReady(map)
    await vi.advanceTimersByTimeAsync(STYLE_READY_TIMEOUT_MS - 1)
    expect(await settled(ready)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(ready).resolves.toBeUndefined()
  })

  it('drops its timer once the style settles, so nothing is left pending', async () => {
    const map = pendingMap()
    const ready = whenStyleReady(map)
    map.fire('load')
    await ready
    expect(vi.getTimerCount()).toBe(0)
  })
})
