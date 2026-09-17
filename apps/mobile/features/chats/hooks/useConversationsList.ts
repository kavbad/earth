/**
 * SCREEN 08 data: `conversations_list` pages through react-query, refetched on realtime message /
 * conversation events (`subscribeConversationsFeed`) and polled every `POLL_INTERVAL_MS` while the
 * channel is degraded. Cached rows stay visible while a refresh fails (spec §110 for lists).
 */
import type { ConversationsPageDto } from '@earth/api'
import type { ConversationSummaryDto } from '@earth/domain'
import type { RealtimeMode } from '@earth/realtime'
import { type InfiniteData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'

import { createChatDiagnostics, subscribeConversationsFeed } from '../realtime'
import { useChatsShell } from '../shell'
import { dedupeConversations } from '../state/list'

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
  const shell = useChatsShell()
  const { earth, supabase, online } = shell
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<RealtimeMode>('realtime')
  const enabled = shell.isHuman

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
    if (!enabled || supabase === null) return
    const subscription = subscribeConversationsFeed({
      supabase,
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
  }, [enabled, supabase, earth, queryClient])

  const conversations = useMemo(() => dedupeConversations(query.data?.pages ?? []), [query.data])

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
