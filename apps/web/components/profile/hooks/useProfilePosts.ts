'use client'

/**
 * The profile's posts (SCREEN 22 "Now"): `posts_by_author` through the typed client — the
 * database decides what the viewer may see (`earth.can_view_post`, visitors: world posts of public
 * profiles) and answers full `PostViewDto`s (author, counts, the viewer's reaction, place, media).
 */
import type { PostViewDto, ProfileDto } from '@earth/domain'
import { useQuery } from '@tanstack/react-query'

import { useEarth, useRuntime } from '../../../lib/providers/RuntimeProvider'
import { useSession } from '../../../lib/providers/SessionProvider'
import { PROFILE_POSTS_LIMIT } from '../state/posts'
import { PROFILE_QUERY_KEY } from './useProfile'

export interface ProfilePosts {
  readonly posts: readonly PostViewDto[]
  readonly loading: boolean
  readonly failed: boolean
}

export function useProfilePosts(profile: ProfileDto | undefined): ProfilePosts {
  const earth = useEarth()
  const { runtime } = useRuntime()
  const session = useSession()
  const humanId = profile?.identity.humanId ?? null
  const handle = profile?.identity.handle ?? null
  const enabled = runtime !== null && session.status === 'ready' && humanId !== null
  const query = useQuery({
    queryKey: [PROFILE_QUERY_KEY, humanId, 'posts', session.humanId],
    queryFn: async () => {
      if (handle === null) return []
      const page = await earth.posts.byAuthor(handle, null, PROFILE_POSTS_LIMIT)
      return page.posts
    },
    enabled,
  })
  return {
    posts: query.data ?? [],
    loading: enabled && query.isPending,
    failed: query.isError && query.data === undefined,
  }
}
