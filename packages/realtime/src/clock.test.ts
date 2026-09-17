import { describe, expect, it, vi } from 'vitest'

import {
  CHANNEL_BACKOFF,
  delay,
  errorReason,
  exponentialBackoffMs,
  scheduleInterval,
  systemClock,
} from './clock'
import { createFakeClock, flushPromises } from './testing/fake-clock'

describe('exponentialBackoffMs', () => {
  it('doubles from the base and caps at the maximum', () => {
    expect(exponentialBackoffMs(1, CHANNEL_BACKOFF)).toBe(1_000)
    expect(exponentialBackoffMs(2, CHANNEL_BACKOFF)).toBe(2_000)
    expect(exponentialBackoffMs(3, CHANNEL_BACKOFF)).toBe(4_000)
    expect(exponentialBackoffMs(6, CHANNEL_BACKOFF)).toBe(30_000)
    expect(exponentialBackoffMs(60, CHANNEL_BACKOFF)).toBe(30_000)
  })

  it('treats failures below one as the first failure', () => {
    expect(exponentialBackoffMs(0, CHANNEL_BACKOFF)).toBe(1_000)
    expect(exponentialBackoffMs(-3, CHANNEL_BACKOFF)).toBe(1_000)
  })
})

describe('scheduleInterval', () => {
  it('fires after every interval until cancelled', () => {
    const clock = createFakeClock()
    const callback = vi.fn()
    const cancel = scheduleInterval(clock, callback, 100)
    clock.advance(99)
    expect(callback).not.toHaveBeenCalled()
    clock.advance(1)
    expect(callback).toHaveBeenCalledTimes(1)
    clock.advance(250)
    expect(callback).toHaveBeenCalledTimes(3)
    cancel()
    clock.advance(1_000)
    expect(callback).toHaveBeenCalledTimes(3)
    expect(clock.pending()).toBe(0)
  })

  it('stops when the callback cancels it', () => {
    const clock = createFakeClock()
    let calls = 0
    const cancel = scheduleInterval(
      clock,
      () => {
        calls += 1
        cancel()
      },
      10,
    )
    clock.advance(100)
    expect(calls).toBe(1)
  })
})

describe('delay', () => {
  it('resolves after the delay', async () => {
    const clock = createFakeClock()
    const pending = delay(clock, 500)
    let resolved = false
    void pending.promise.then(() => {
      resolved = true
    })
    await clock.advanceAsync(499)
    expect(resolved).toBe(false)
    await clock.advanceAsync(1)
    expect(resolved).toBe(true)
  })

  it('resolves immediately when cancelled', async () => {
    const clock = createFakeClock()
    const pending = delay(clock, 500)
    pending.cancel()
    await flushPromises()
    await expect(pending.promise).resolves.toBeUndefined()
    expect(clock.pending()).toBe(0)
  })
})

describe('errorReason', () => {
  it('uses messages, names, strings and message-like objects', () => {
    expect(errorReason(new Error('boom'))).toBe('boom')
    expect(errorReason(new TypeError(''))).toBe('TypeError')
    expect(errorReason('plain')).toBe('plain')
    expect(errorReason({ message: 'from object' })).toBe('from object')
    expect(errorReason(42)).toBe('42')
  })
})

describe('systemClock', () => {
  it('schedules and cancels real timers', async () => {
    vi.useFakeTimers()
    try {
      const callback = vi.fn()
      const cancel = systemClock.schedule(callback, 10)
      cancel()
      vi.advanceTimersByTime(20)
      expect(callback).not.toHaveBeenCalled()
      systemClock.schedule(callback, 10)
      vi.advanceTimersByTime(20)
      expect(callback).toHaveBeenCalledTimes(1)
      expect(typeof systemClock.now()).toBe('number')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createFakeClock', () => {
  it('fires timers in time order and lets fired timers schedule more', () => {
    const clock = createFakeClock(0)
    const order: string[] = []
    clock.schedule(() => order.push('b'), 20)
    clock.schedule(() => {
      order.push('a')
      clock.schedule(() => order.push('a2'), 5)
    }, 10)
    expect(clock.nextDelay()).toBe(10)
    clock.advance(30)
    expect(order).toEqual(['a', 'a2', 'b'])
    expect(clock.now()).toBe(30)
    expect(clock.nextDelay()).toBeNull()
  })
})
