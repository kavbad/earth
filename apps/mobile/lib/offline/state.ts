/**
 * Global offline state (spec §107) without a connectivity module: the device is assumed online
 * until a request fails for network reasons (`suspect`), then a probe of `/api/health` settles it
 * and keeps probing while offline, backing off from 3 s to 30 s. The app stays navigable; the
 * shell shows "Waiting for connection" while offline and clears it as soon as a probe succeeds.
 */

export const HEALTH_PROBE_PATH = '/api/health' as const
/** Delay before the first retry while offline (ms); doubles up to `OFFLINE_PROBE_MAX_MS`. */
export const OFFLINE_PROBE_BASE_MS = 3_000
export const OFFLINE_PROBE_MAX_MS = 30_000
/** @deprecated Kept for readers of the fixed cadence; the shell now backs off (`probeDelayMs`). */
export const OFFLINE_PROBE_INTERVAL_MS = 10_000
/** How long a probe may take before it counts as failed (ms). */
export const PROBE_TIMEOUT_MS = 5_000

export interface OnlineState {
  readonly online: boolean
  /** True between a suspicion (a failed request, a return to the foreground) and the probe that settles it. */
  readonly checking: boolean
  /** Consecutive failed probes; the banner appears from the first failure. */
  readonly failures: number
}

export type OnlineEvent =
  | { readonly type: 'suspect' }
  | { readonly type: 'foreground' }
  | { readonly type: 'probe_ok' }
  | { readonly type: 'probe_failed' }

export const INITIAL_ONLINE_STATE: OnlineState = { online: true, checking: false, failures: 0 }

export function onlineReducer(state: OnlineState, event: OnlineEvent): OnlineState {
  switch (event.type) {
    case 'suspect':
      return state.checking ? state : { ...state, checking: true }
    case 'foreground':
      // Coming back after a while: confirm when we were offline; an online device stays as is.
      return state.online || state.checking ? state : { ...state, checking: true }
    case 'probe_ok':
      return { online: true, checking: false, failures: 0 }
    case 'probe_failed':
      return { online: false, checking: false, failures: state.failures + 1 }
    default: {
      const exhaustive: never = event
      throw new Error(`Unknown online event: ${String(exhaustive)}`)
    }
  }
}

/** Whether the shell should probe now: offline, or a suspicion awaits confirmation. */
export function shouldProbe(state: OnlineState): boolean {
  return !state.online || state.checking
}

/**
 * Delay before the next probe (ms): none while a suspicion is being confirmed (and on a return
 * to the foreground), then 3 s, 6 s, 12 s … capped at 30 s while the device stays offline.
 */
export function probeDelayMs(state: OnlineState): number {
  if (state.checking) return 0
  const exponent = Math.max(0, state.failures - 1)
  return Math.min(OFFLINE_PROBE_BASE_MS * 2 ** exponent, OFFLINE_PROBE_MAX_MS)
}

export function healthProbeUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl.replace(/\/+$/, '')}${HEALTH_PROBE_PATH}`
}

const NETWORK_MESSAGE =
  /network request failed|failed to fetch|network error|timeout|timed out|aborted|abort/i

/** A failure the network explains (fetch refused, timed out) rather than the server answering. */
export function isNetworkError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const candidate = error as {
    message?: unknown
    name?: unknown
    details?: unknown
    code?: unknown
  }
  if (candidate.name === 'AbortError') return true
  if (typeof candidate.message === 'string' && NETWORK_MESSAGE.test(candidate.message)) return true
  const details = candidate.details
  if (details !== null && typeof details === 'object') {
    const reason = (details as { reason?: unknown }).reason
    if (reason === 'network_error') return true
  }
  return false
}
