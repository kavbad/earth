'use client'

/**
 * Feature flags (spec §118, ARCHITECTURE §12): `me_get()` already carries the `feature_flags`
 * rows, so they arrive with the session; a direct `flags.resolved()` read covers the case where
 * `me_get()` failed. Launch defaults apply until either answers.
 */
import { featureFlagsFromDto } from '@earth/api'
import { FEATURE_FLAG_DEFAULTS, type FeatureFlags } from '@earth/config'
import { useQuery } from '@tanstack/react-query'
import { type ReactNode, createContext, useContext, useMemo } from 'react'

import { useEarth, useRuntime } from './RuntimeProvider'
import { useSession } from './SessionProvider'

const FlagsContext = createContext<FeatureFlags>(FEATURE_FLAG_DEFAULTS)

export const FLAGS_QUERY_KEY = ['flags'] as const

export function FlagsProvider({ children }: { readonly children: ReactNode }) {
  const { runtime } = useRuntime()
  const earth = useEarth()
  const session = useSession()
  const fromMe = useMemo(
    () => (session.me === null ? null : featureFlagsFromDto(session.me.flags)),
    [session.me],
  )
  const fallback = useQuery({
    queryKey: FLAGS_QUERY_KEY,
    queryFn: () => earth.flags.resolved(),
    enabled: runtime !== null && session.status === 'ready' && fromMe === null,
    staleTime: 60_000,
  })
  const flags = fromMe ?? fallback.data ?? FEATURE_FLAG_DEFAULTS
  return <FlagsContext.Provider value={flags}>{children}</FlagsContext.Provider>
}

export function useFlags(): FeatureFlags {
  return useContext(FlagsContext)
}
