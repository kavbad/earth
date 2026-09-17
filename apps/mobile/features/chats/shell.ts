/**
 * The one seam between the chats feature and the app shell. Every chats hook and screen reaches
 * the shell through `useChatsShell()`; nothing else in `features/chats` or `components/chats`
 * imports a provider. The shell exposes the same hooks as the web client's `lib/providers`
 * (`useEarth`, `useRuntime`, `useSession`, `useOnline`, `useAnalytics`, `useFlags`,
 * `usePublicEnv`, `useClaimGate`, `useToast`) — if the mobile shell names them differently, this
 * file is the only place to adapt.
 *
 * All data goes through the `EarthClient` (ARCHITECTURE §7); the Supabase client is handed over
 * only as the structural `RealtimeClientLike` `@earth/realtime` needs for channels (§8).
 */
import type { AnalyticsEventMap, ClaimEntryPoint, EventName } from '@earth/analytics'
import type { EarthClient } from '@earth/api'
import type { FeatureFlags } from '@earth/config'
import type { HumanId, RoleKind } from '@earth/domain'
import type { RealtimeClientLike } from '@earth/realtime'
import { useMemo } from 'react'

import { CANONICAL_WEB_ORIGIN } from '@/lib/deeplinks'
import {
  useAnalytics,
  useClaimGate,
  useEarth,
  useFlags,
  useOnline,
  usePublicEnv,
  useRuntime,
  useSession,
  useToast,
} from '@/lib/providers'

export type SessionStatus = 'loading' | 'ready'

export interface ChatsShell {
  /** The typed application API. */
  readonly earth: EarthClient
  /** Realtime channels; `null` until the runtime exists (subscriptions wait). */
  readonly supabase: RealtimeClientLike | null
  readonly sessionStatus: SessionStatus
  readonly roleKind: RoleKind
  readonly viewerId: HumanId | null
  /** `roleKind === 'human'` with a ready session: the only state that can message. */
  readonly isHuman: boolean
  /** `false` while the device cannot reach Earth ("Waiting for connection", spec §107). */
  readonly online: boolean
  readonly flags: FeatureFlags
  /** Origin of invite links (`https://earth.social`, spec §112). */
  readonly webOrigin: string
  track<E extends EventName>(name: E, properties: AnalyticsEventMap[E]): void
  /** Opens the claim sheet (Visitors and Guests) and returns `false`; Humans pass with `true`. */
  requireHuman(entry?: ClaimEntryPoint): boolean
  /** Opens the claim sheet (spec §43 — "Claim your place to join the conversation."). */
  openClaim(entry?: ClaimEntryPoint): void
  /** One short line above the content, never a stack of alerts. */
  toast(message: string): void
}

/**
 * The validated `WEB_ORIGIN` (`@earth/config` through the shell's `usePublicEnv`), or the
 * canonical origin while the build has no valid environment — never a raw `process.env` read.
 */
function resolveWebOrigin(fromEnv: string | undefined): string {
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : CANONICAL_WEB_ORIGIN
}

export function useChatsShell(): ChatsShell {
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
  const sessionStatus: SessionStatus = session.status
  const roleKind: RoleKind = session.roleKind
  const viewerId: HumanId | null = session.humanId
  const webOrigin = resolveWebOrigin(env?.WEB_ORIGIN)
  const track = analytics.track
  const requireHuman = gate.requireHuman
  const openClaim = gate.open
  const toast = toastApi.show
  return useMemo<ChatsShell>(
    () => ({
      earth,
      supabase,
      sessionStatus,
      roleKind,
      viewerId,
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
      sessionStatus,
      roleKind,
      viewerId,
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
