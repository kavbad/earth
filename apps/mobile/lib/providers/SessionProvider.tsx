/**
 * Who is here (ARCHITECTURE §4): the Supabase session plus `me_get()`, kept current through
 * `onAuthStateChange`. `roleKind` is a reflection of the database's answer, never authority.
 */
import type { MeDto } from '@earth/domain'
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { LOADING_SESSION, type SessionSnapshot, deriveSession } from '../session/state'
import { useRuntime } from './RuntimeProvider'

export interface SessionContextValue extends SessionSnapshot {
  /** Re-reads the session and `me_get()` (after a claim, a sign-in, a profile change). */
  refresh(): Promise<SessionSnapshot>
  signOut(): Promise<void>
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function SessionProvider({ children }: { readonly children: ReactNode }) {
  const { runtime } = useRuntime()
  const [snapshot, setSnapshot] = useState<SessionSnapshot>(LOADING_SESSION)
  const generation = useRef(0)

  const refresh = useCallback(async (): Promise<SessionSnapshot> => {
    const ticket = ++generation.current
    if (runtime === null) {
      // No runtime: the shell still renders, as a Visitor, so the configuration line is visible.
      await Promise.resolve()
      const visitor = deriveSession(null, null)
      if (ticket === generation.current) setSnapshot(visitor)
      return visitor
    }
    let session = null
    try {
      session = await runtime.session.getSession()
    } catch {
      session = null
    }
    let me: MeDto | null = null
    try {
      me = await runtime.earth.me.get()
    } catch {
      // Offline or a server hiccup: the credential still tells us enough to render.
      me = null
    }
    const next = deriveSession(session, me)
    // A later refresh may have finished first; never let a stale answer win.
    if (ticket === generation.current) setSnapshot(next)
    return next
  }, [runtime])

  useEffect(() => {
    void refresh()
    if (runtime === null) return
    const unsubscribe = runtime.session.onChange((_session, event) => {
      // Token refreshes do not change who the person is; sign-in/out and user updates do.
      if (event === 'TOKEN_REFRESHED') return
      void refresh()
    })
    return unsubscribe
  }, [runtime, refresh])

  const signOut = useCallback(async () => {
    if (runtime === null) return
    await runtime.session.signOut()
    await refresh()
  }, [runtime, refresh])

  const value = useMemo<SessionContextValue>(
    () => ({ ...snapshot, refresh, signOut }),
    [snapshot, refresh, signOut],
  )

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext)
  if (value === null) throw new Error('useSession must be used within <EarthProviders>')
  return value
}
