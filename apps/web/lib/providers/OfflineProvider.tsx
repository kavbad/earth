'use client'

/**
 * Global offline state (spec §107): browser online/offline events confirmed by a probe of
 * `/api/health`. Exposes `useOnline()`; the shell renders "Waiting for connection" from it.
 */
import { type ReactNode, createContext, useContext, useEffect, useReducer } from 'react'

import {
  HEALTH_PROBE_PATH,
  OFFLINE_PROBE_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
  initialOnlineState,
  onlineReducer,
  shouldProbe,
} from '../offline/state'

const OnlineContext = createContext<boolean>(true)

async function probe(): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const response = await fetch(HEALTH_PROBE_PATH, {
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
  const [state, dispatch] = useReducer(onlineReducer, true, initialOnlineState)

  useEffect(() => {
    const onOnline = () => dispatch({ type: 'browser_online' })
    const onOffline = () => dispatch({ type: 'browser_offline' })
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    if (!navigator.onLine) dispatch({ type: 'browser_offline' })
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  useEffect(() => {
    if (!shouldProbe(state)) return
    let cancelled = false
    const run = async () => {
      const ok = await probe()
      if (!cancelled) dispatch({ type: ok ? 'probe_ok' : 'probe_failed' })
    }
    void run()
    const interval = setInterval(() => {
      void run()
    }, OFFLINE_PROBE_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [state])

  return <OnlineContext.Provider value={state.online}>{children}</OnlineContext.Provider>
}

/** `false` while the device cannot reach Earth (the shell shows "Waiting for connection"). */
export function useOnline(): boolean {
  return useContext(OnlineContext)
}
