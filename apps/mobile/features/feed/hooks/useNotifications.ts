/**
 * SCREEN 23 data: `notifications_list` pages in the server's order (priority rank, then newest),
 * refetched on realtime inserts and every `NOTIFICATIONS_POLL_INTERVAL_MS` while the channel is
 * degraded. Rows are marked read as they come on screen (optimistic).
 */
import type { HumanId, NotificationDto, NotificationId, NotificationsPageDto } from '@earth/domain'
import type { RealtimeMode } from '@earth/realtime'
import { type InfiniteData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { lightTap } from '@/lib/haptics'
import { createNotificationDiagnostics, subscribeNotifications } from '../realtime'
import { useFeedShell } from '../shell'
import {
  type NotificationRow,
  mergeNotificationPages,
  notificationRow,
  withNotificationRead,
} from '../state/notifications'

export const NOTIFICATIONS_QUERY_KEY = 'notifications' as const
export const NOTIFICATIONS_POLL_INTERVAL_MS = 30_000
export const NOTIFICATIONS_REFETCH_DEBOUNCE_MS = 400

export interface NotificationsController {
  readonly rows: readonly NotificationRow[]
  readonly unreadCount: number
  readonly loading: boolean
  readonly failed: boolean
  readonly refreshFailed: boolean
  readonly refreshing: boolean
  readonly hasMore: boolean
  readonly loadingMore: boolean
  readonly mode: RealtimeMode
  readonly enabled: boolean
  loadMore(): void
  refresh(): void
  markRead(id: NotificationId): void
  acceptFriend(row: NotificationRow, actorHumanId: HumanId): Promise<boolean>
}

export function useNotifications(): NotificationsController {
  const shell = useFeedShell()
  const { earth, supabase, online, track } = shell
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<RealtimeMode>('realtime')
  const enabled = shell.ready && shell.isHuman
  const queryKey = useMemo(
    () => [NOTIFICATIONS_QUERY_KEY, shell.viewerId] as const,
    [shell.viewerId],
  )

  const query = useInfiniteQuery<
    NotificationsPageDto,
    Error,
    InfiniteData<NotificationsPageDto, string | null>,
    typeof queryKey,
    string | null
  >({
    queryKey,
    queryFn: ({ pageParam }) => earth.notifications.list({ cursor: pageParam }),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled,
    refetchInterval:
      enabled && online && mode === 'polling' ? NOTIFICATIONS_POLL_INTERVAL_MS : false,
  })

  const invalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!enabled || supabase === null) return
    const subscription = subscribeNotifications({
      supabase,
      diagnostics: createNotificationDiagnostics(earth),
      onStatus: (status) => setMode(status.mode),
      onChange: () => {
        if (invalidateTimer.current !== null) clearTimeout(invalidateTimer.current)
        invalidateTimer.current = setTimeout(() => {
          invalidateTimer.current = null
          void queryClient.invalidateQueries({ queryKey })
        }, NOTIFICATIONS_REFETCH_DEBOUNCE_MS)
      },
    })
    return () => {
      subscription.unsubscribe()
      if (invalidateTimer.current !== null) clearTimeout(invalidateTimer.current)
      invalidateTimer.current = null
    }
  }, [enabled, supabase, earth, queryClient, queryKey])

  const pages = query.data?.pages
  const rows = useMemo(
    () => (pages === undefined ? [] : mergeNotificationPages(pages).map(notificationRow)),
    [pages],
  )
  const unreadCount = pages?.[0]?.unreadCount ?? 0

  const marking = useRef<Set<string>>(new Set())
  const markRead = useCallback(
    (id: NotificationId) => {
      if (marking.current.has(id)) return
      const current =
        queryClient.getQueryData<InfiniteData<NotificationsPageDto, string | null>>(queryKey)
      const target: NotificationDto | undefined = current?.pages
        .flatMap((page) => page.notifications)
        .find((n) => n.id === id)
      if (target === undefined || target.readAt !== null) return
      marking.current.add(id)
      const readAt = new Date().toISOString()
      queryClient.setQueryData<InfiniteData<NotificationsPageDto, string | null>>(
        queryKey,
        (data) =>
          data === undefined
            ? data
            : { ...data, pages: withNotificationRead(data.pages, id, readAt) },
      )
      earth.notifications
        .markRead(id)
        .catch(() => undefined)
        .finally(() => marking.current.delete(id))
    },
    [earth, queryClient, queryKey],
  )

  const acceptFriend = useCallback(
    async (row: NotificationRow, actorHumanId: HumanId) => {
      lightTap()
      try {
        await earth.social.acceptFriend(actorHumanId)
        track('friend_accepted', { requesterHumanId: actorHumanId, source: 'notifications' })
        markRead(row.id)
        void queryClient.invalidateQueries({ queryKey })
        return true
      } catch {
        return false
      }
    },
    [earth, markRead, queryClient, queryKey, track],
  )

  const { hasNextPage, isFetchingNextPage, fetchNextPage, refetch } = query
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])
  const refresh = useCallback(() => {
    void refetch()
  }, [refetch])

  return {
    rows,
    unreadCount,
    loading: enabled && query.isPending,
    failed: query.isError && query.data === undefined,
    refreshFailed: query.isError && query.data !== undefined,
    refreshing: query.isRefetching && !query.isFetchingNextPage,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    mode,
    enabled,
    loadMore,
    refresh,
    markRead,
    acceptFriend,
  }
}
