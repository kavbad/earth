'use client'

/**
 * The radius per surface (spec §51): Friends for Humans, World for Visitors, remembered through
 * `scope_set` for Humans (with a per-device cache) and on the device for Visitors.
 */
import type { Scope } from '@earth/domain'
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
} from 'react'

import {
  type ScopeAvailability,
  type ScopeMap,
  type ScopeSurface,
  availabilityByScope,
  defaultScopeFor,
  initialScopes,
  rememberScope,
  scopeReducer,
} from '../scope/state'
import { localStore } from '../storage'
import { useFlags } from './FlagsProvider'
import { useEarth, useRuntime } from './RuntimeProvider'
import { useSession } from './SessionProvider'

interface ScopeContextValue {
  readonly scopes: ScopeMap
  readonly availability: Readonly<Record<Scope, ScopeAvailability>>
  setScope(surface: ScopeSurface, scope: Scope): void
}

const ScopeContext = createContext<ScopeContextValue | null>(null)

const VISITOR_SCOPES: ScopeMap = { home: 'world', live: 'world', earth: 'world' }

export function ScopeProvider({ children }: { readonly children: ReactNode }) {
  const { runtime } = useRuntime()
  const earth = useEarth()
  const flags = useFlags()
  const session = useSession()
  const [scopes, dispatch] = useReducer(scopeReducer, VISITOR_SCOPES)

  // Re-derive when the person changes (sign-in, claim, sign-out) or the flags arrive.
  useEffect(() => {
    if (session.status !== 'ready') return
    dispatch({
      type: 'reset',
      scopes: initialScopes({
        roleKind: session.roleKind,
        humanId: session.humanId,
        storage: localStore(),
        flags,
      }),
    })
  }, [session.status, session.roleKind, session.humanId, flags])

  const availability = useMemo(
    () => availabilityByScope({ roleKind: session.roleKind, flags }),
    [session.roleKind, flags],
  )

  const setScope = useCallback(
    (surface: ScopeSurface, scope: Scope) => {
      dispatch({ type: 'set', surface, scope })
      rememberScope(localStore(), surface, session.humanId, scope)
      if (runtime !== null && session.roleKind === 'human') {
        earth.location.setScope({ surface, scope }).catch(() => {
          // The device cache already remembers it; the server copy catches up next time.
        })
      }
    },
    [earth, runtime, session.humanId, session.roleKind],
  )

  const value = useMemo<ScopeContextValue>(
    () => ({ scopes, availability, setScope }),
    [scopes, availability, setScope],
  )
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>
}

export interface SurfaceScope {
  readonly scope: Scope
  readonly availability: Readonly<Record<Scope, ScopeAvailability>>
  setScope(scope: Scope): void
}

export function useScope(surface: ScopeSurface): SurfaceScope {
  const value = useContext(ScopeContext)
  const session = useSession()
  if (value === null) throw new Error('useScope must be used within <EarthProviders>')
  const setScope = useCallback((scope: Scope) => value.setScope(surface, scope), [value, surface])
  return {
    scope: value.scopes[surface] ?? defaultScopeFor(session.roleKind),
    availability: value.availability,
    setScope,
  }
}
