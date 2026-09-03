/**
 * The one seam between the Home / posts / profile / notifications / search feature and the app
 * shell. Every hook and screen under `features/feed`, `components/feed`, `components/posts` and
 * `components/profile` reaches the shell through `useFeedShell()` / `useHomeScope()`; nothing
 * else imports a provider. The shell exposes the same hooks as the web client's `lib/providers`
 * (`useEarth`, `useRuntime`, `useSession`, `useOnline`, `useAnalytics`, `useFlags`,
 * `usePublicEnv`, `useScope`, `useClaimGate`, `useToast`) — if the mobile shell names them
 * differently, this file is the only place to adapt.
 *
 * All data goes through the `EarthClient` (ARCHITECTURE §7); the Supabase client is handed over
 * only as the structural `RealtimeClientLike` `@earth/realtime` needs for channels (§8).
 */
import type { AnalyticsEventMap, ClaimEntryPoint, EventName } from '@earth/analytics'
import type { EarthClient } from '@earth/api'
import type { FeatureFlags } from '@earth/config'
import type { HumanId, MeDto, PublicIdentityDto, RoleKind, Scope } from '@earth/domain'
import type { RealtimeClientLike } from '@earth/realtime'
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

export type SessionStatus = 'loading' | 'ready'

/** `available` opens a radius; `claim` shows the claim sheet; `disabled` is inert (flag off). */
export type ScopeAvailability = 'available' | 'claim' | 'disabled'

export interface FeedShell {
  /** The typed application API. */
  readonly earth: EarthClient
  /** Realtime channels; `null` until the runtime exists (subscriptions wait). */
  readonly supabase: RealtimeClientLike | null
  /** The runtime exists and the session has resolved: reads may start. */
  readonly ready: boolean
  readonly sessionStatus: SessionStatus
  readonly roleKind: RoleKind
  readonly viewerId: HumanId | null
  readonly identity: PublicIdentityDto | null
  readonly me: MeDto | null
  /** `roleKind === 'human'` with a ready session: the only state that can act (spec §43). */
  readonly isHuman: boolean
  /** `false` while the device cannot reach Earth ("Waiting for connection", spec §107). */
  readonly online: boolean
  readonly flags: FeatureFlags
  /** Origin of share links (`https://earth.social`, spec §112). */
  readonly webOrigin: string
  track<E extends EventName>(name: E, properties: AnalyticsEventMap[E]): void
  /** Opens the claim sheet (Visitors and Guests) and returns `false`; Humans pass with `true`. */
  requireHuman(entry?: ClaimEntryPoint): boolean
  openClaim(entry?: ClaimEntryPoint): void
  /** One short line, never a stack of alerts. */
  toast(message: string): void
}

/**
 * The validated `WEB_ORIGIN` (`@earth/config` through the shell's `usePublicEnv`), or the
 * canonical origin while the build has no valid environment — never a raw `process.env` read.
 */
function resolveWebOrigin(fromEnv: string | undefined): string {
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : CANONICAL_WEB_ORIGIN
}

export function useFeedShell(): FeedShell {
  const earth = useEarth()
  const { runtime } = useRuntime()
  const session = useSession()
  const online = useOnline()
  const analytics = useAnalytics()
  const flags = useFlags()
  const env = usePublicEnv()
  const gate = useClaimGate()
  const toastApi = useToast()
  const supabase: RealtimeClientLike | null = runtime?.supabase ?? null
  const hasRuntime = runtime !== null
  const sessionStatus: SessionStatus = session.status
  const roleKind: RoleKind = session.roleKind
  const viewerId: HumanId | null = session.humanId
  const identity: PublicIdentityDto | null = session.identity
  const me: MeDto | null = session.me
  const webOrigin = resolveWebOrigin(env?.WEB_ORIGIN)
  const track = analytics.track
  const requireHuman = gate.requireHuman
  const openClaim = gate.open
  const toast = toastApi.show
  return useMemo<FeedShell>(
    () => ({
      earth,
      supabase,
      ready: hasRuntime && sessionStatus === 'ready',
      sessionStatus,
      roleKind,
      viewerId,
      identity,
      me,
      isHuman: sessionStatus === 'ready' && roleKind === 'human' && viewerId !== null,
      online,
      flags,
      webOrigin,
      track,
      requireHuman,
      openClaim,
      toast,
    }),
    [
      earth,
      supabase,
      hasRuntime,
      sessionStatus,
      roleKind,
      viewerId,
      identity,
      me,
      online,
      flags,
      webOrigin,
      track,
      requireHuman,
      openClaim,
      toast,
    ],
  )
}

export interface HomeScope {
  readonly scope: Scope
  readonly availability: Readonly<Record<Scope, ScopeAvailability>>
  setScope(scope: Scope): void
}

/** The Home radius (spec §51): Friends for Humans, World for Visitors, remembered by the shell. */
export function useHomeScope(): HomeScope {
  const { scope, availability, setScope } = useScope('home')
  const set = useCallback((next: Scope) => setScope(next), [setScope])
  return useMemo<HomeScope>(
    () => ({ scope, availability, setScope: set }),
    [scope, availability, set],
  )
}
