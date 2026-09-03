/**
 * Injected time source for every timer in `@earth/realtime`.
 *
 * Nothing in this package calls `setTimeout` or `Date.now()` directly: join timeouts, polling
 * cadence, reconnect backoff, typing expiry and presence pings all go through a `RealtimeClock`,
 * so tests drive them with a fake clock and production passes `systemClock`.
 */

/** Cancels a timer created by `RealtimeClock.schedule`. Safe to call more than once. */
export type CancelTimer = () => void

export interface RealtimeClock {
  /** Milliseconds since the epoch (`Date.now()` in production). */
  now(): number
  /** Runs `callback` once after `delayMs`; the returned function cancels the timer. */
  schedule(callback: () => void, delayMs: number): CancelTimer
}

export const systemClock: RealtimeClock = {
  now: () => Date.now(),
  schedule(callback, delayMs) {
    const handle = setTimeout(callback, delayMs)
    return () => clearTimeout(handle)
  },
}

/**
 * Repeats `callback` every `intervalMs` (the first run happens after one interval) until the
 * returned function is called. A callback that cancels the interval stops further runs.
 */
export function scheduleInterval(
  clock: RealtimeClock,
  callback: () => void,
  intervalMs: number,
): CancelTimer {
  let cancelled = false
  let cancelCurrent: CancelTimer = () => {}
  const tick = (): void => {
    if (cancelled) return
    callback()
    if (cancelled) return
    cancelCurrent = clock.schedule(tick, intervalMs)
  }
  cancelCurrent = clock.schedule(tick, intervalMs)
  return () => {
    cancelled = true
    cancelCurrent()
  }
}

export interface CancellableDelay {
  /** Resolves after the delay, or immediately when `cancel()` is called. */
  readonly promise: Promise<void>
  readonly cancel: CancelTimer
}

/** A delay that can be cut short (used by reconnect loops that are torn down mid-backoff). */
export function delay(clock: RealtimeClock, delayMs: number): CancellableDelay {
  let resolveDelay: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    resolveDelay = resolve
  })
  const cancelTimer = clock.schedule(() => resolveDelay(), delayMs)
  return {
    promise,
    cancel: () => {
      cancelTimer()
      resolveDelay()
    },
  }
}

export interface BackoffPolicy {
  readonly baseMs: number
  readonly maxMs: number
}

/** Realtime channel re-subscribe backoff: 1 s, 2 s, 4 s, ... capped at 30 s (ARCHITECTURE §8). */
export const CHANNEL_BACKOFF: BackoffPolicy = { baseMs: 1_000, maxMs: 30_000 }

const MAX_BACKOFF_EXPONENT = 30

/** Delay before retry number `failures` (1-based): `baseMs * 2^(failures - 1)`, capped at `maxMs`. */
export function exponentialBackoffMs(failures: number, policy: BackoffPolicy): number {
  const exponent = Math.min(Math.max(0, Math.floor(failures) - 1), MAX_BACKOFF_EXPONENT)
  return Math.min(policy.maxMs, policy.baseMs * 2 ** exponent)
}

/** A free-text reason for diagnostics; `EarthError` codes and `Error` messages, never user content. */
export function errorReason(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}
