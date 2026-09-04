/**
 * Error monitoring (spec §14): the app's `ErrorMonitor` (Sentry when `EXPO_PUBLIC_SENTRY_DSN` is
 * set, otherwise the console in development or noop) with the person attached — a Human by id and
 * public handle, never a credential. `useErrorMonitor()` for `captureException` in hooks.
 */
import type { ErrorMonitor } from '@earth/observability'
import { type ReactNode, createContext, useContext, useEffect, useState } from 'react'

import { getErrorMonitor } from '../observability/monitor'
import { monitorIdentityFor } from '../observability/setup'
import { useSession } from './SessionProvider'

const ErrorMonitorContext = createContext<ErrorMonitor | null>(null)

export function ErrorMonitorProvider({ children }: { readonly children: ReactNode }) {
  const [monitor] = useState<ErrorMonitor>(getErrorMonitor)
  const session = useSession()
  const { status, humanId, identity } = session

  useEffect(() => {
    if (status !== 'ready') return
    monitor.setUser(monitorIdentityFor({ humanId, identity }))
  }, [monitor, status, humanId, identity])

  return <ErrorMonitorContext.Provider value={monitor}>{children}</ErrorMonitorContext.Provider>
}

export function useErrorMonitor(): ErrorMonitor {
  const value = useContext(ErrorMonitorContext)
  if (value === null) throw new Error('useErrorMonitor must be used within <EarthProviders>')
  return value
}
