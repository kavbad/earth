/**
 * The Home feed for one radius (SCREEN 01–05; spec §70, §110): `GET /api/feed` pages through
 * react-query, cached per viewer × radius × area so switching radius shows cached cards at once
 * and a failed refresh keeps them on screen with an inline "Couldn't refresh".
 */
import type { AreaId, FeedPageDto, Scope } from '@earth/domain'
import { type InfiniteData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'

import { useFeedShell } from '../shell'
import { FEED_QUERY_KEY, type FeedView, feedQueryKey, feedView, viewerKeyFor } from '../state/feed'

export interface FeedController {
  readonly scope: Scope
  readonly view: FeedView
  /** No cached cards yet and the first page is on its way. */
  readonly loading: boolean
  /** The first page failed and nothing is cached. */
  readonly failed: boolean
  /** A refresh failed while cached cards stay on screen (spec §110). */
  readonly refreshFailed: boolean
  readonly refreshing: boolean
  readonly hasMore: boolean
  readonly loadingMore: boolean
  readonly enabled: boolean
  loadMore(): void
  refresh(): Promise<void>
}

export interface UseFeedOptions {
  readonly scope: Scope
  readonly areaId: AreaId | null
  readonly hiddenPostIds: ReadonlySet<string>
  /** `false` when the radius is not open to this person (flag off, Visitor outside World). */
  readonly enabled: boolean
}

export function useFeed(options: UseFeedOptions): FeedController {
  const shell = useFeedShell()
  const { earth } = shell
  const viewerKey = viewerKeyFor(shell.viewerId)
  const enabled = options.enabled && shell.ready
  const queryKey = feedQueryKey(options.scope, options.areaId, viewerKey)

  const query = useInfiniteQuery<
    FeedPageDto,
    Error,
    InfiniteData<FeedPageDto, string | null>,
    typeof queryKey,
    string | null
  >({
    queryKey,
    queryFn: ({ pageParam }) => earth.feed.page(options.scope, pageParam, options.areaId),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled,
  })

  const pages = query.data?.pages
  const view = useMemo(
    () => feedView(pages ?? [], options.hiddenPostIds),
    [pages, options.hiddenPostIds],
  )

  const { hasNextPage, isFetchingNextPage, isFetching, fetchNextPage, refetch } = query
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage && !isFetching) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, isFetching, fetchNextPage])

  const refresh = useCallback(async () => {
    await refetch()
  }, [refetch])

  return {
    scope: options.scope,
    view,
    loading: enabled && query.isPending,
    failed: query.isError && query.data === undefined,
    refreshFailed: query.isError && query.data !== undefined,
    refreshing: query.isRefetching && !query.isFetchingNextPage,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    enabled,
    loadMore,
    refresh,
  }
}

/** Drops every cached feed page of the viewer (after posting, hiding, blocking). */
export function useInvalidateFeed(): () => Promise<void> {
  const queryClient = useQueryClient()
  const shell = useFeedShell()
  const viewerKey = viewerKeyFor(shell.viewerId)
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: [FEED_QUERY_KEY, viewerKey] }),
    [queryClient, viewerKey],
  )
}
