'use client'

/**
 * Hands the browser runtime (`./runtime.ts`) to every hook below it. Created synchronously in the
 * first client render so screens can use `useEarth()` immediately; the server render gets the
 * rejecting stub (`./stub.ts`), which nothing calls during render. A broken public environment
 * is reported on screen after mount instead of thrown from a render.
 */
import type { EarthClient } from '@earth/api'
import type { PublicEnv } from '@earth/config'
import {
  type ReactNode,
  createContext,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'

import { webCopy } from '../copy'
import { type WebRuntime, type WebRuntimeResult, getWebRuntime } from './runtime'
import { createStubEarthClient } from './stub'

export interface RuntimeContextValue {
  readonly runtime: WebRuntime | null
  readonly earth: EarthClient
  readonly env: PublicEnv | null
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null)

function initialResult(): WebRuntimeResult | null {
  return typeof window === 'undefined' ? null : getWebRuntime()
}

const subscribeNever = (): (() => void) => () => undefined
const noIssues = (): null => null

export function RuntimeProvider({ children }: { readonly children: ReactNode }) {
  const [result] = useState<WebRuntimeResult | null>(initialResult)
  // Server snapshot: no issues (nothing was read); client snapshot: the validation result.
  const issues = useSyncExternalStore(
    subscribeNever,
    () => (result !== null && !result.ok ? result.issues : null),
    noIssues,
  )

  const value = useMemo<RuntimeContextValue>(() => {
    const runtime = result !== null && result.ok ? result.runtime : null
    return {
      runtime,
      earth: runtime?.earth ?? createStubEarthClient(),
      env: runtime?.env ?? null,
    }
  }, [result])

  return (
    <RuntimeContext.Provider value={value}>
      {children}
      {issues !== null ? <EnvIssues issues={issues} /> : null}
    </RuntimeContext.Provider>
  )
}

function EnvIssues({ issues }: { readonly issues: readonly string[] }) {
  return (
    <div
      role="alert"
      className="fixed inset-x-0 bottom-0 z-modal bg-background p-screen-margin text-secondary text-text-primary hairline-t"
    >
      <p className="font-weight-semibold">{webCopy.envMissing}</p>
      <ul className="mt-2 text-text-secondary">
        {issues.map((issue) => (
          <li key={issue}>{issue}</li>
        ))}
      </ul>
    </div>
  )
}

export function useRuntime(): RuntimeContextValue {
  const value = useContext(RuntimeContext)
  if (value === null) throw new Error('useRuntime must be used within <EarthProviders>')
  return value
}

/** The typed application API (ARCHITECTURE §7). Components never touch supabase directly. */
export function useEarth(): EarthClient {
  return useRuntime().earth
}

/** The validated public environment; `null` during server rendering. */
export function usePublicEnv(): PublicEnv | null {
  return useRuntime().env
}
