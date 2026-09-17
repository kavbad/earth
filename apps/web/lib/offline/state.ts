/**
 * Global offline state (spec §107): the browser's `navigator.onLine` is a hint, a probe of
 * `/api/health` is the confirmation. The app stays navigable; the shell shows
 * "Waiting for connection" while offline and clears it as soon as a probe succeeds.
 */

export const HEALTH_PROBE_PATH = '/api/health' as const
/** How often to probe while offline (ms). */
export const OFFLINE_PROBE_INTERVAL_MS = 10_000
/** How long a probe may take before it counts as failed (ms). */
export const PROBE_TIMEOUT_MS = 5_000

export interface OnlineState {
  readonly online: boolean
  /** True between a browser `offline`/`online` event and the probe that settles it. */
  readonly checking: boolean
  /** Consecutive failed probes; the banner appears from the first failure. */
  readonly failures: number
}

export type OnlineEvent =
  | { readonly type: 'browser_online' }
  | { readonly type: 'browser_offline' }
  | { readonly type: 'probe_ok' }
  | { readonly type: 'probe_failed' }

export function initialOnlineState(navigatorOnline: boolean): OnlineState {
  return { online: navigatorOnline, checking: false, failures: 0 }
}

export function onlineReducer(state: OnlineState, event: OnlineEvent): OnlineState {
  switch (event.type) {
    case 'browser_offline':
      return { online: false, checking: false, failures: state.failures }
    case 'browser_online':
      // The browser may be optimistic (captive portals); confirm with a probe before clearing.
      return { ...state, checking: true }
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

/** Whether the shell should probe now: offline, or a browser event awaits confirmation. */
export function shouldProbe(state: OnlineState): boolean {
  return !state.online || state.checking
}
