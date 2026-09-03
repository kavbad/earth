'use client'

/**
 * The profile's posts (SCREEN 22 "Now"): visible `posts` rows by the Human through the typed
 * client's transport (RLS decides what the viewer may see), shaped with the profile identity.
 */
import { FILTER_OPERATORS } from '@earth/api'
import type { PostViewDto, ProfileDto } from '@earth/domain'
import { useQuery } from '@tanstack/react-query'

import { useEarth, useRuntime } from '../../../lib/providers/RuntimeProvider'
import { useSession } from '../../../lib/providers/SessionProvider'
import {
  PROFILE_POSTS_FETCH_LIMIT,
  PROFILE_POSTS_TABLE,
  PROFILE_POST_COLUMNS,
  ProfilePostRowsSchema,
  postViewFromRow,
  selectProfilePosts,
} from '../state/posts'
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
  const enabled = runtime !== null && session.status === 'ready' && humanId !== null
  const query = useQuery({
    queryKey: [PROFILE_QUERY_KEY, humanId, 'posts', session.humanId],
    queryFn: async () => {
      if (profile === undefined || humanId === null) return []
      const rows = await earth.transport.query(
        `select ${PROFILE_POSTS_TABLE}`,
        (table) =>
          table
            .select(PROFILE_POST_COLUMNS)
            .filter('author_human_id', FILTER_OPERATORS.eq, humanId)
            .order('created_at', { ascending: false })
            .limit(PROFILE_POSTS_FETCH_LIMIT),
        PROFILE_POSTS_TABLE,
        ProfilePostRowsSchema,
      )
      return selectProfilePosts(rows, humanId).map((row) => postViewFromRow(row, profile.identity))
    },
    enabled,
  })
  return {
    posts: query.data ?? [],
    loading: enabled && query.isPending,
    failed: query.isError && query.data === undefined,
  }
}
