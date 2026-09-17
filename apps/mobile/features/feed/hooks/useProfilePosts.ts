/**
 * The profile's posts (SCREEN 22 "Now"): `posts_by_author` through the typed client — the
 * database decides what the viewer may see (`earth.can_view_post`; Visitors: World posts of
 * public profiles) and answers full `PostViewDto`s (author, counts, the viewer's reaction, place,
 * media). Later pages follow the keyset cursor.
 */
import type { PostsByAuthorPageDto } from '@earth/api'
import type { PostViewDto, ProfileDto } from '@earth/domain'
import { type InfiniteData, useInfiniteQuery } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'

import { useFeedShell } from '../shell'
import { PROFILE_POSTS_LIMIT, mergeProfilePostPages } from '../state/profile'
import { PROFILE_QUERY_KEY } from './useProfile'

export interface ProfilePosts {
  readonly posts: readonly PostViewDto[]
  readonly loading: boolean
  readonly failed: boolean
  readonly hasMore: boolean
  readonly loadingMore: boolean
  loadMore(): void
}

export function profilePostsQueryKey(humanId: string | null, viewerId: string | null) {
  return [PROFILE_QUERY_KEY, humanId, 'posts', viewerId] as const
}

export function useProfilePosts(profile: ProfileDto | undefined): ProfilePosts {
  const shell = useFeedShell()
  const { earth } = shell
  const humanId = profile?.identity.humanId ?? null
  const handle = profile?.identity.handle ?? null
  const enabled = shell.ready && humanId !== null && handle !== null
  const queryKey = profilePostsQueryKey(humanId, shell.viewerId)
  const query = useInfiniteQuery<
    PostsByAuthorPageDto,
    Error,
    InfiniteData<PostsByAuthorPageDto, string | null>,
    typeof queryKey,
    string | null
  >({
    queryKey,
    queryFn: ({ pageParam }) => earth.posts.byAuthor(handle ?? '', pageParam, PROFILE_POSTS_LIMIT),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled,
  })
  const pages = query.data?.pages
  const posts = useMemo(() => (pages === undefined ? [] : mergeProfilePostPages(pages)), [pages])
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage])
  return {
    posts,
    loading: enabled && query.isPending,
    failed: query.isError && query.data === undefined,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    loadMore,
  }
}
