/**
 * Hands the app runtime (`../runtime.ts`) to every hook below it. Created synchronously in the
 * first render so screens can use `useEarth()` immediately. A broken public environment is
 * reported on screen after mount instead of thrown from a render. The Supabase token refresh
 * follows the app state (it must not run while the app is backgrounded).
 */
import type { EarthClient } from '@earth/api'
import type { PublicEnv } from '@earth/config'
import { colors, space, spacing } from '@earth/ui'
import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from 'react'
import { AppState, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { text } from '@/components/ui/text'

import { shellCopy } from '../copy'
import { type MobileRuntime, type MobileRuntimeResult, getMobileRuntime } from '../runtime'
import { createStubEarthClient } from './stub'

export interface RuntimeContextValue {
  readonly runtime: MobileRuntime | null
  readonly earth: EarthClient
  readonly env: PublicEnv | null
}

const RuntimeContext = createContext<RuntimeContextValue | null>(null)

export function RuntimeProvider({ children }: { readonly children: ReactNode }) {
  const [result] = useState<MobileRuntimeResult>(getMobileRuntime)

  const value = useMemo<RuntimeContextValue>(() => {
    const runtime = result.ok ? result.runtime : null
    return {
      runtime,
      earth: runtime?.earth ?? createStubEarthClient(),
      env: runtime?.env ?? null,
    }
  }, [result])

  // supabase-js refreshes tokens on a timer; run it only while the app is in the foreground.
  useEffect(() => {
    const runtime = value.runtime
    if (runtime === null) return
    const auth = runtime.supabase.auth
    const apply = (state: string) => {
      if (state === 'active') auth.startAutoRefresh()
      else auth.stopAutoRefresh()
    }
    apply(AppState.currentState)
    const subscription = AppState.addEventListener('change', apply)
    return () => {
      subscription.remove()
      auth.stopAutoRefresh()
    }
  }, [value.runtime])

  return (
    <RuntimeContext.Provider value={value}>
      {children}
      {result.ok ? null : <EnvIssues issues={result.issues} />}
    </RuntimeContext.Provider>
  )
}

function EnvIssues({ issues }: { readonly issues: readonly string[] }) {
  const insets = useSafeAreaInsets()
  return (
    <View
      style={[styles.issues, { paddingBottom: insets.bottom + space[4] }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
    >
      <Text style={[text.bodyMedium, text.primary]}>{shellCopy.envMissing}</Text>
      {issues.map((issue) => (
        <Text key={issue} style={[text.secondary, text.muted]}>
          {issue}
        </Text>
      ))}
    </View>
  )
}

export function useRuntime(): RuntimeContextValue {
  const value = useContext(RuntimeContext)
  if (value === null) throw new Error('useRuntime must be used within <EarthProviders>')
  return value
}

/** The typed application API (ARCHITECTURE §7). Screens never touch supabase directly. */
export function useEarth(): EarthClient {
  return useRuntime().earth
}

/** The validated public environment; `null` when the build is misconfigured. */
export function usePublicEnv(): PublicEnv | null {
  return useRuntime().env
}

const styles = StyleSheet.create({
  issues: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.background,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.separator,
    paddingHorizontal: spacing.screenMargin,
    paddingTop: space[4],
    gap: space[1],
  },
})
