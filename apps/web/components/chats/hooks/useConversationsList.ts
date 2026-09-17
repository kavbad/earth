'use client'

/**
 * SCREEN 08 data: `conversations_list` pages through react-query, refetched on realtime message /
 * conversation events (`subscribeConversationsFeed`) and polled every `POLL_INTERVAL_MS` while the
 * channel is degraded. Cached rows stay visible while a refresh fails (spec §110 for lists).
 */
import type { ConversationsPageDto } from '@earth/api'
import type { ConversationSummaryDto } from '@earth/domain'
import { type RealtimeMode } from '@earth/realtime'
import { type InfiniteData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'

import { useOnline } from '../../../lib/providers/OfflineProvider'
import { useEarth, useRuntime } from '../../../lib/providers/RuntimeProvider'
import { useSession } from '../../../lib/providers/SessionProvider'
import { createChatDiagnostics, subscribeConversationsFeed } from '../realtime'

export const CONVERSATIONS_QUERY_KEY = ['conversations'] as const
/** List refresh cadence while the realtime channel is unavailable. */
export const CONVERSATIONS_POLL_INTERVAL_MS = 15_000
/** Realtime events are coalesced so a burst of messages is one refetch. */
export const CONVERSATIONS_REFETCH_DEBOUNCE_MS = 400

export interface ConversationsList {
  readonly conversations: readonly ConversationSummaryDto[]
  readonly loading: boolean
  readonly refreshing: boolean
  /** A refresh failed while cached rows are shown, or the first load failed. */
  readonly error: boolean
  readonly hasMore: boolean
  readonly loadingMore: boolean
  readonly mode: RealtimeMode
  loadMore(): void
  refetch(): void
}

export function useConversationsList(): ConversationsList {
  const earth = useEarth()
  const { runtime } = useRuntime()
  const session = useSession()
  const online = useOnline()
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<RealtimeMode>('realtime')
  const enabled = runtime !== null && session.status === 'ready' && session.roleKind === 'human'

  const query = useInfiniteQuery<
    ConversationsPageDto,
    Error,
    InfiniteData<ConversationsPageDto, string | null>,
    typeof CONVERSATIONS_QUERY_KEY,
    string | null
  >({
    queryKey: CONVERSATIONS_QUERY_KEY,
    queryFn: ({ pageParam }) => earth.conversations.list({ cursor: pageParam }),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled,
    refetchInterval:
      enabled && online && mode === 'polling' ? CONVERSATIONS_POLL_INTERVAL_MS : false,
  })

  const invalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!enabled || runtime === null) return
    const subscription = subscribeConversationsFeed({
      supabase: runtime.supabase,
      diagnostics: createChatDiagnostics(earth),
      onStatus: (status) => setMode(status.mode),
      onChange: () => {
        if (invalidateTimer.current !== null) clearTimeout(invalidateTimer.current)
        invalidateTimer.current = setTimeout(() => {
          invalidateTimer.current = null
          void queryClient.invalidateQueries({ queryKey: CONVERSATIONS_QUERY_KEY })
        }, CONVERSATIONS_REFETCH_DEBOUNCE_MS)
      },
    })
    return () => {
      subscription.unsubscribe()
      if (invalidateTimer.current !== null) clearTimeout(invalidateTimer.current)
      invalidateTimer.current = null
    }
  }, [enabled, runtime, earth, queryClient])

  const conversations = useMemo(() => {
    const pages = query.data?.pages ?? []
    const seen = new Set<string>()
    const rows: ConversationSummaryDto[] = []
    for (const page of pages) {
      for (const conversation of page.conversations) {
        if (seen.has(conversation.id)) continue
        seen.add(conversation.id)
        rows.push(conversation)
      }
    }
    return rows
  }, [query.data])

  return {
    conversations,
    loading: enabled && query.isPending,
    refreshing: query.isFetching && !query.isFetchingNextPage,
    error: query.isError,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    mode,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage()
    },
    refetch: () => {
      void query.refetch()
    },
  }
}
