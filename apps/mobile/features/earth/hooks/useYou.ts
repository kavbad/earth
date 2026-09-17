/**
 * SCREEN 24 data: the viewer's own profile (`profile_get` on the own handle, for the quiet
 * counts) and own posts out of the Friends feed (the pool includes the viewer's own posts).
 */
import type { FeedPostCardDto, ProfileDto } from '@earth/domain'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { useEarthShell } from '../shell'
import { ownPosts } from '../state/you'

export const YOU_PROFILE_QUERY_KEY = 'you-profile' as const
export const YOU_POSTS_QUERY_KEY = 'you-posts' as const
const EMPTY: readonly FeedPostCardDto[] = []

export interface YouProfile {
  readonly profile: ProfileDto | undefined
  readonly loading: boolean
  readonly failed: boolean
  refetch(): void
}

export function useYouProfile(): YouProfile {
  const shell = useEarthShell()
  const { earth } = shell
  const handle = shell.identity?.handle ?? null
  const enabled = shell.ready && shell.isHuman && handle !== null
  const query = useQuery({
    queryKey: [YOU_PROFILE_QUERY_KEY, handle],
    queryFn: () => earth.social.profile(handle ?? ''),
    enabled,
    staleTime: 60_000,
  })
  const { refetch } = query
  return {
    profile: query.data,
    loading: enabled && query.isPending,
    failed: query.isError && query.data === undefined,
    refetch: () => {
      void refetch()
    },
  }
}

export interface OwnPosts {
  readonly posts: readonly FeedPostCardDto[]
  readonly loaded: boolean
  readonly loading: boolean
  readonly failed: boolean
  refetch(): void
}

export function useOwnPosts(): OwnPosts {
  const shell = useEarthShell()
  const { earth } = shell
  const enabled = shell.ready && shell.isHuman
  const query = useQuery({
    queryKey: [YOU_POSTS_QUERY_KEY, shell.viewerId],
    queryFn: () => earth.feed.page('friends'),
    enabled,
    staleTime: 30_000,
  })
  const cards = query.data?.cards
  const viewerId = shell.viewerId
  const posts = useMemo(
    () => (cards === undefined ? EMPTY : ownPosts(cards, viewerId)),
    [cards, viewerId],
  )
  const { refetch } = query
  return {
    posts,
    loaded: query.data !== undefined,
    loading: enabled && query.isPending,
    failed: query.isError && query.data === undefined,
    refetch: () => {
      void refetch()
    },
  }
}
