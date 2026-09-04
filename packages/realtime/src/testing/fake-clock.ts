/**
 * Deterministic clock for tests: timers fire only when `advance` moves time past them.
 */
import type { CancelTimer, RealtimeClock } from '../clock'

interface FakeTimer {
  readonly id: number
  readonly at: number
  readonly callback: () => void
}

export interface FakeClock extends RealtimeClock {
  /** Moves time forward, firing due timers in order (timers scheduled while firing may fire too). */
  advance(ms: number): void
  /** Like `advance`, yielding to settled promises after every timer so async chains progress. */
  advanceAsync(ms: number): Promise<void>
  /** Number of armed timers. */
  pending(): number
  /** Delay until the next timer, or `null`. */
  nextDelay(): number | null
}

/** Lets promise chains created by timers settle. */
export async function flushPromises(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => {
      queueMicrotask(resolve)
    })
  }
}

export function createFakeClock(startMs = 1_000_000): FakeClock {
  let now = startMs
  let nextId = 1
  let timers: FakeTimer[] = []

  const takeDue = (until: number): FakeTimer | undefined => {
    const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0]
    if (due === undefined) return undefined
    timers = timers.filter((t) => t.id !== due.id)
    return due
  }

  return {
    now: () => now,
    schedule(callback, delayMs): CancelTimer {
      const timer: FakeTimer = { id: nextId++, at: now + Math.max(0, delayMs), callback }
      timers.push(timer)
      return () => {
        timers = timers.filter((t) => t.id !== timer.id)
      }
    },
    advance(ms) {
      const until = now + ms
      for (let due = takeDue(until); due !== undefined; due = takeDue(until)) {
        now = Math.max(now, due.at)
        due.callback()
      }
      now = until
    },
    async advanceAsync(ms) {
      const until = now + ms
      await flushPromises()
      for (let due = takeDue(until); due !== undefined; due = takeDue(until)) {
        now = Math.max(now, due.at)
        due.callback()
        await flushPromises()
      }
      now = until
      await flushPromises()
    },
    pending: () => timers.length,
    nextDelay() {
      if (timers.length === 0) return null
      return Math.max(0, Math.min(...timers.map((t) => t.at)) - now)
    },
  }
}
