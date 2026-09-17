/**
 * The one seam between the Live / room feature and the app shell. Every room hook and screen
 * reaches the shell through `useRoomShell()`; nothing else under `features/rooms` or
 * `components/rooms` imports a provider.
 */
import type { AnalyticsEventMap, ClaimEntryPoint, EventName } from '@earth/analytics'
import type { EarthClient } from '@earth/api'
import type { FeatureFlags } from '@earth/config'
import type { HumanId, RoleKind } from '@earth/domain'
import type { RealtimeClientLike } from '@earth/realtime'
import { useMemo } from 'react'

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

export interface RoomShell {
  readonly earth: EarthClient
  /** Realtime channels; `null` until the runtime exists (subscriptions wait). */
  readonly supabase: RealtimeClientLike | null
  readonly ready: boolean
  readonly sessionStatus: SessionStatus
  readonly roleKind: RoleKind
  readonly viewerId: HumanId | null
  readonly isHuman: boolean
  readonly online: boolean
  readonly flags: FeatureFlags
  /** The web origin room links point at (`WEB_ORIGIN`); `null` until the environment loads. */
  readonly webOrigin: string | null
  track<E extends EventName>(name: E, properties: AnalyticsEventMap[E]): void
  requireHuman(entry?: ClaimEntryPoint): boolean
  toast(message: string): void
}

export function useRoomShell(): RoomShell {
  const earth = useEarth()
  const { runtime } = useRuntime()
  const env = usePublicEnv()
  const session = useSession()
  const online = useOnline()
  const analytics = useAnalytics()
  const flags = useFlags()
  const gate = useClaimGate()
  const toastApi = useToast()
  const supabase: RealtimeClientLike | null = runtime?.supabase ?? null
  const hasRuntime = runtime !== null
  const sessionStatus: SessionStatus = session.status
  const roleKind: RoleKind = session.roleKind
  const viewerId: HumanId | null = session.humanId
  const webOrigin: string | null = env?.WEB_ORIGIN ?? null
  const track = analytics.track
  const requireHuman = gate.requireHuman
  const toast = toastApi.show
  return useMemo<RoomShell>(
    () => ({
      earth,
      supabase,
      ready: hasRuntime && sessionStatus === 'ready',
      sessionStatus,
      roleKind,
      viewerId,
      isHuman: sessionStatus === 'ready' && roleKind === 'human' && viewerId !== null,
      online,
      flags,
      webOrigin,
      track,
      requireHuman,
      toast,
    }),
    [
      earth,
      supabase,
      hasRuntime,
      sessionStatus,
      roleKind,
      viewerId,
      online,
      flags,
      webOrigin,
      track,
      requireHuman,
      toast,
    ],
  )
}
