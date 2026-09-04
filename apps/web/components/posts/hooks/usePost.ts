'use client'

/**
 * One post and its replies (SCREEN 07): `post_get` through react-query (seeded by the server
 * render for public links), `post_replies` pages for the thread, and `post_create` with
 * `parentPostId` for a reply — audience forced within the root's (spec §72).
 */
import type { PostCreateArgs, PostRepliesPageDto } from '@earth/api'
import {
  type Audience,
  type PostDetailDto,
  type PostDto,
  type PostId,
  type PostViewDto,
  asPostId,
} from '@earth/domain'
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { useMemo } from 'react'

import { useAnalytics } from '../../../lib/providers/AnalyticsProvider'
import { useEarth, useRuntime } from '../../../lib/providers/RuntimeProvider'
import { useSession } from '../../../lib/providers/SessionProvider'
import { localStore } from '../../../lib/storage'
import { useInvalidateFeed } from '../../feed/hooks/useFeed'
import { rememberLastAudience } from '../state/audience'
import { POST_QUERY_KEY, postQueryKey } from './usePostActions'

export function repliesQueryKey(postId: PostId) {
  return [POST_QUERY_KEY, postId, 'replies'] as const
}

export interface PostController {
  readonly detail: PostDetailDto | undefined
  readonly loading: boolean
  readonly failed: boolean
  readonly refreshFailed: boolean
  refresh(): void
}

/** `postId` may be `null` (nothing to load — the composer without a reply target). */
export function usePost(postId: PostId | null, initial?: PostDetailDto | null): PostController {
  const earth = useEarth()
  const { runtime } = useRuntime()
  const session = useSession()
  const enabled = runtime !== null && session.status === 'ready' && postId !== null
  const query = useQuery({
    queryKey: [POST_QUERY_KEY, postId],
    queryFn: () => earth.posts.get(postId ?? asPostId('00000000-0000-4000-8000-000000000000')),
    enabled,
    ...(initial === undefined || initial === null ? {} : { initialData: initial, staleTime: 0 }),
  })
  return {
    detail: query.data,
    loading: enabled && query.isPending,
    failed: query.isError && query.data === undefined,
    refreshFailed: query.isError && query.data !== undefined,
    refresh: () => {
      void query.refetch()
    },
  }
}

export interface RepliesController {
  readonly replies: readonly PostViewDto[]
  readonly hasMore: boolean
  readonly loadingMore: boolean
  readonly failed: boolean
  loadMore(): void
}

/** The thread: the first page from `post_get`, later pages from `post_replies`. */
export function useReplies(postId: PostId, initial: readonly PostViewDto[]): RepliesController {
  const earth = useEarth()
  const { runtime } = useRuntime()
  const session = useSession()
  const enabled = runtime !== null && session.status === 'ready'
  const queryKey = repliesQueryKey(postId)
  const query = useInfiniteQuery<
    PostRepliesPageDto,
    Error,
    InfiniteData<PostRepliesPageDto, string | null>,
    typeof queryKey,
    string | null
  >({
    queryKey,
    queryFn: ({ pageParam }) => earth.posts.replies({ postId, cursor: pageParam }),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled,
  })
  const replies = useMemo(() => {
    const pages = query.data?.pages
    if (pages === undefined) return initial
    const seen = new Set<string>()
    const rows: PostViewDto[] = []
    for (const page of pages) {
      for (const reply of page.replies) {
        if (seen.has(reply.post.id)) continue
        seen.add(reply.post.id)
        rows.push(reply)
      }
    }
    return rows
  }, [query.data?.pages, initial])
  return {
    replies,
    hasMore: query.hasNextPage,
    loadingMore: query.isFetchingNextPage,
    failed: query.isError && query.data === undefined && initial.length === 0,
    loadMore: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage()
    },
  }
}

export interface CreatePostInput extends Omit<PostCreateArgs, 'clientId'> {
  readonly audience: Audience
}

export interface CreatePost {
  create(input: CreatePostInput): Promise<PostDto>
  readonly pending: boolean
  readonly failed: boolean
}

/** `post_create`, then the feed and (for replies) the thread refresh; tracks `post_created` / `post_replied`. */
export function useCreatePost(): CreatePost {
  const earth = useEarth()
  const analytics = useAnalytics()
  const session = useSession()
  const queryClient = useQueryClient()
  const invalidateFeed = useInvalidateFeed()
  const mutation = useMutation({
    mutationFn: (input: CreatePostInput) =>
      earth.posts.create({ ...input, clientId: earth.transport.randomId() }),
    onSuccess: (post, input) => {
      rememberLastAudience(localStore(), session.humanId, post.audience)
      if (input.parentPostId === null) {
        analytics.track('post_created', {
          postId: post.id,
          type: post.type,
          audience: post.audience,
          hasMedia: input.media.length > 0,
          hasPlace: input.placeId !== null,
        })
      } else {
        const parentId = asPostId(input.parentPostId)
        analytics.track('post_replied', {
          postId: parentId,
          audience: post.audience,
          isNested: post.rootPostId !== null && post.rootPostId !== post.parentPostId,
        })
        void queryClient.invalidateQueries({ queryKey: postQueryKey(parentId) })
        if (post.rootPostId !== null) {
          void queryClient.invalidateQueries({ queryKey: postQueryKey(post.rootPostId) })
        }
      }
      void invalidateFeed()
    },
  })
  return {
    create: (input) => mutation.mutateAsync(input),
    pending: mutation.isPending,
    failed: mutation.isError,
  }
}
