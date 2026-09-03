/**
 * One post and its replies (SCREEN 07): `post_get` through react-query, `post_replies` pages for
 * the thread, and `post_create` with `parentPostId` for a reply — audience forced within the
 * root's (spec §72). Creating tracks `post_created` / `post_replied` and refreshes the feed.
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

import { useFeedShell } from '../shell'
import { useInvalidateFeed } from './useFeed'
import { rememberLastAudience } from './useLastAudience'

export const POST_QUERY_KEY = 'post' as const

export function postQueryKey(postId: PostId): readonly [typeof POST_QUERY_KEY, PostId] {
  return [POST_QUERY_KEY, postId]
}

export function repliesQueryKey(postId: PostId) {
  return [POST_QUERY_KEY, postId, 'replies'] as const
}

/** A placeholder id for a disabled query; never sent (the query does not run without a post). */
const NO_POST = asPostId('00000000-0000-4000-8000-000000000000')

export interface PostController {
  readonly detail: PostDetailDto | undefined
  readonly loading: boolean
  readonly failed: boolean
  readonly refreshFailed: boolean
  refresh(): void
}

/** `postId` may be `null` (nothing to load — the composer without a reply target). */
export function usePost(postId: PostId | null): PostController {
  const shell = useFeedShell()
  const enabled = shell.ready && postId !== null
  const query = useQuery({
    queryKey: [POST_QUERY_KEY, postId],
    queryFn: () => shell.earth.posts.get(postId ?? NO_POST),
    enabled,
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
  const shell = useFeedShell()
  const queryKey = repliesQueryKey(postId)
  const query = useInfiniteQuery<
    PostRepliesPageDto,
    Error,
    InfiniteData<PostRepliesPageDto, string | null>,
    typeof queryKey,
    string | null
  >({
    queryKey,
    queryFn: ({ pageParam }) => shell.earth.posts.replies({ postId, cursor: pageParam }),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: shell.ready,
  })
  const pages = query.data?.pages
  const replies = useMemo(() => {
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
  }, [pages, initial])
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
  const shell = useFeedShell()
  const { earth, track, viewerId } = shell
  const queryClient = useQueryClient()
  const invalidateFeed = useInvalidateFeed()
  const mutation = useMutation({
    mutationFn: (input: CreatePostInput) =>
      earth.posts.create({ ...input, clientId: earth.transport.randomId() }),
    onSuccess: (post, input) => {
      rememberLastAudience(queryClient, viewerId, post.audience)
      if (input.parentPostId === null) {
        track('post_created', {
          postId: post.id,
          type: post.type,
          audience: post.audience,
          hasMedia: input.media.length > 0,
          hasPlace: input.placeId !== null,
        })
      } else {
        const parentId = asPostId(input.parentPostId)
        track('post_replied', {
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
