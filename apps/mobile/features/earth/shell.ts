/**
 * The one seam between the Earth / You / Settings / Safety / Location feature and the app shell.
 * Every hook and screen under `features/earth`, `components/map`, `components/location` and
 * `components/safety` reaches the shell through `useEarthShell()` / `useEarthScope()`; nothing
 * else imports a provider. The shell exposes the same hooks as the web client's `lib/providers`
 * (`useEarth`, `useRuntime`, `useSession`, `useOnline`, `useAnalytics`, `useFlags`,
 * `usePublicEnv`, `useScope`, `useClaimGate`, `useToast`) — if the mobile shell names them
 * differently, this file is the only place to adapt.
 *
 * All data goes through the `EarthClient` (ARCHITECTURE §7); screens never touch supabase. The
 * auth client behind "Access credentials" is read structurally off the runtime, so nothing here
 * depends on the runtime's exact type.
 */
import type { AnalyticsEventMap, ClaimEntryPoint, EventName } from '@earth/analytics'
import type { EarthClient } from '@earth/api'
import type { AuthSessionLike } from '@earth/auth'
import type { FeatureFlags } from '@earth/config'
import type { HumanId, MeDto, PublicIdentityDto, RoleKind, Scope } from '@earth/domain'
import { useCallback, useMemo } from 'react'

import { CANONICAL_WEB_ORIGIN } from '@/lib/deeplinks'
import {
  useAnalytics,
  useClaimGate,
  useEarth,
  useFlags,
  useOnline,
  usePublicEnv,
  useRuntime,
  useScope,
  useSession,
  useToast,
} from '@/lib/providers'

import { type CredentialAuthLike, credentialAuthFrom } from './state/credentials'

export type SessionStatus = 'loading' | 'ready'

/** `available` opens a radius; `claim` shows the claim sheet; `disabled` is inert (flag off). */
export type ScopeAvailability = 'available' | 'claim' | 'disabled'

export interface EarthShell {
  /** The typed application API. */
  readonly earth: EarthClient
  /** The runtime exists and the session has resolved: reads may start. */
  readonly ready: boolean
  readonly sessionStatus: SessionStatus
  readonly roleKind: RoleKind
  readonly viewerId: HumanId | null
  readonly identity: PublicIdentityDto | null
  readonly me: MeDto | null
  /** The credential session (email / phone live on it), `null` for Visitors. */
  readonly authSession: AuthSessionLike | null
  /** The auth client for adding a credential, when the runtime exposes one. */
  readonly credentialAuth: CredentialAuthLike | null
  /** `roleKind === 'human'` with a ready session: the only state that can act (spec §43). */
  readonly isHuman: boolean
  /** `false` while the device cannot reach Earth ("Waiting for connection", spec §107). */
  readonly online: boolean
  readonly flags: FeatureFlags
  /** Origin of share links (`https://earth.social`, spec §112). */
  readonly webOrigin: string
  /** Optional map style URL for a tile provider (`EXPO_PUBLIC_MAP_STYLE_URL`). */
  readonly mapStyleUrl: string | null
  track<E extends EventName>(name: E, properties: AnalyticsEventMap[E]): void
  /** Opens the claim sheet (Visitors and Guests) and returns `false`; Humans pass with `true`. */
  requireHuman(entry?: ClaimEntryPoint): boolean
  openClaim(entry?: ClaimEntryPoint): void
  /** One short line, never a stack of alerts. */
  toast(message: string): void
  /** Re-reads the session and `me_get()` (after a profile change, a context change). */
  refreshSession(): Promise<unknown>
  signOut(): Promise<void>
}

/**
 * The validated `WEB_ORIGIN` (`@earth/config` through the shell's `usePublicEnv`), or the
 * canonical origin while the build has no valid environment — never a raw `process.env` read.
 */
function resolveWebOrigin(fromEnv: string | undefined): string {
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : CANONICAL_WEB_ORIGIN
}

function resolveMapStyleUrl(fromEnv: string | undefined): string | null {
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : null
}

export function useEarthShell(): EarthShell {
  const earth = useEarth()
  const { runtime } = useRuntime()
  const session = useSession()
  const online = useOnline()
  const analytics = useAnalytics()
  const flags = useFlags()
  const env = usePublicEnv()
  const gate = useClaimGate()
  const toastApi = useToast()
  const hasRuntime = runtime !== null
  const sessionStatus: SessionStatus = session.status
  const roleKind: RoleKind = session.roleKind
  const viewerId: HumanId | null = session.humanId
  const identity: PublicIdentityDto | null = session.identity
  const me: MeDto | null = session.me
  const authSession: AuthSessionLike | null = session.session
  const credentialAuth = useMemo(() => credentialAuthFrom(runtime), [runtime])
  const webOrigin = resolveWebOrigin(env?.WEB_ORIGIN)
  const mapStyleUrl = resolveMapStyleUrl(env?.MAP_STYLE_URL)
  const track = analytics.track
  const requireHuman = gate.requireHuman
  const openClaim = gate.open
  const toast = toastApi.show
  const refreshSession = session.refresh
  const signOut = session.signOut
  return useMemo<EarthShell>(
    () => ({
      earth,
      ready: hasRuntime && sessionStatus === 'ready',
      sessionStatus,
      roleKind,
      viewerId,
      identity,
      me,
      authSession,
      credentialAuth,
      isHuman: sessionStatus === 'ready' && roleKind === 'human' && viewerId !== null,
      online,
      flags,
      webOrigin,
      mapStyleUrl,
      track,
      requireHuman,
      openClaim,
      toast,
      refreshSession,
      signOut,
    }),
    [
      earth,
      hasRuntime,
      sessionStatus,
      roleKind,
      viewerId,
      identity,
      me,
      authSession,
      credentialAuth,
      online,
      flags,
      webOrigin,
      mapStyleUrl,
      track,
      requireHuman,
      openClaim,
      toast,
      refreshSession,
      signOut,
    ],
  )
}

export interface EarthScope {
  readonly scope: Scope
  readonly availability: Readonly<Record<Scope, ScopeAvailability>>
  setScope(scope: Scope): void
}

/** The Earth radius (spec §51): Friends for Humans, World for Visitors, remembered by the shell. */
export function useEarthScope(): EarthScope {
  const { scope, availability, setScope } = useScope('earth')
  const set = useCallback((next: Scope) => setScope(next), [setScope])
  return useMemo<EarthScope>(
    () => ({ scope, availability, setScope: set }),
    [scope, availability, set],
  )
}
