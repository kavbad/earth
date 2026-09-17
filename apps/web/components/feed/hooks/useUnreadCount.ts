'use client'

/**
 * The unread count behind Home's Notifications control (SCREEN 02 → 23): `notifications_unread_count`
 * for Humans, read again whenever Home mounts (`staleTime: 0`, so coming back from the list settles
 * the dot) and every `UNREAD_POLL_INTERVAL_MS` while online. Visitors never ask.
 */
import { useQuery } from '@tanstack/react-query'

import { useOnline } from '../../../lib/providers/OfflineProvider'
import { useEarth, useRuntime } from '../../../lib/providers/RuntimeProvider'
import { useSession } from '../../../lib/providers/SessionProvider'

export const UNREAD_QUERY_KEY = 'notifications-unread' as const
export const UNREAD_POLL_INTERVAL_MS = 60_000

export function unreadQueryKey(humanId: string | null) {
  return [UNREAD_QUERY_KEY, humanId] as const
}

/** `0` for Visitors and while the count is unknown. */
export function useUnreadCount(): number {
  const earth = useEarth()
  const { runtime } = useRuntime()
  const session = useSession()
  const online = useOnline()
  const enabled = runtime !== null && session.status === 'ready' && session.roleKind === 'human'
  const query = useQuery({
    queryKey: unreadQueryKey(session.humanId),
    queryFn: () => earth.notifications.unreadCount(),
    enabled,
    staleTime: 0,
    refetchInterval: enabled && online ? UNREAD_POLL_INTERVAL_MS : false,
  })
  return enabled ? (query.data ?? 0) : 0
}
