/**
 * Global offline state (spec §107): a failed request is a suspicion, a probe of `/api/health`
 * settles it, and the probe repeats with backoff while offline and at once when the app returns
 * to the foreground. No connectivity module and no `navigator`: the fetch probe is the detector.
 * Exposes `useOnline()`; the shell renders "Waiting for connection" from it.
 */
import { useQueryClient } from '@tanstack/react-query'
import { type ReactNode, createContext, useContext, useEffect, useReducer } from 'react'
import { AppState } from 'react-native'

import {
  INITIAL_ONLINE_STATE,
  PROBE_TIMEOUT_MS,
  healthProbeUrl,
  isNetworkError,
  onlineReducer,
  probeDelayMs,
  shouldProbe,
} from '../offline/state'
import { useRuntime } from './RuntimeProvider'

const OnlineContext = createContext<boolean>(true)

async function probe(url: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export function OfflineProvider({ children }: { readonly children: ReactNode }) {
  const { env } = useRuntime()
  const queryClient = useQueryClient()
  const [state, dispatch] = useReducer(onlineReducer, INITIAL_ONLINE_STATE)

  // Any query or mutation that failed for network reasons is a suspicion worth a probe.
  useEffect(() => {
    const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') {
        if (isNetworkError(event.action.error)) dispatch({ type: 'suspect' })
      }
    })
    const unsubscribeMutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') {
        if (isNetworkError(event.action.error)) dispatch({ type: 'suspect' })
      }
    })
    return () => {
      unsubscribeQueries()
      unsubscribeMutations()
    }
  }, [queryClient])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') dispatch({ type: 'foreground' })
    })
    return () => subscription.remove()
  }, [])

  // One probe per state; each failure re-enters here with a longer delay (backoff).
  useEffect(() => {
    if (env === null || !shouldProbe(state)) return
    const url = healthProbeUrl(env.API_BASE_URL)
    let cancelled = false
    const timer = setTimeout(() => {
      void probe(url).then((ok) => {
        if (!cancelled) dispatch({ type: ok ? 'probe_ok' : 'probe_failed' })
      })
    }, probeDelayMs(state))
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [env, state])

  return <OnlineContext.Provider value={state.online}>{children}</OnlineContext.Provider>
}

/** `false` while the device cannot reach Earth (the shell shows "Waiting for connection"). */
export function useOnline(): boolean {
  return useContext(OnlineContext)
}
