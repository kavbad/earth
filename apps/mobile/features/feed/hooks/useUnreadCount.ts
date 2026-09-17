/**
 * The unread notifications count for the Home header's Notifications control (SCREEN 02/23):
 * `notifications_unread_count()` for Humans, refreshed when the app returns to the foreground and
 * every `UNREAD_POLL_INTERVAL_MS` while online, and dropped by the list when rows are read.
 */
import { useQuery } from '@tanstack/react-query'

import { useFeedShell } from '../shell'

export const UNREAD_QUERY_KEY = 'notifications-unread' as const
export const UNREAD_POLL_INTERVAL_MS = 60_000

export function unreadQueryKey(viewerId: string | null) {
  return [UNREAD_QUERY_KEY, viewerId] as const
}

/** `0` for Visitors and while the count is unknown. */
export function useUnreadCount(): number {
  const shell = useFeedShell()
  const enabled = shell.ready && shell.isHuman
  const query = useQuery({
    queryKey: unreadQueryKey(shell.viewerId),
    queryFn: () => shell.earth.notifications.unreadCount(),
    enabled,
    refetchInterval: enabled && shell.online ? UNREAD_POLL_INTERVAL_MS : false,
  })
  return enabled ? (query.data ?? 0) : 0
}
