'use client'

/**
 * SCREEN 22 "Now": the profile's posts as the same post objects as Home. Rows come from the
 * `posts` table; a media post fills in its media from `post_get` once it scrolls into view.
 */
import type { PostViewDto, ProfileDto } from '@earth/domain'
import { copy } from '@earth/ui'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { useEarth, useRuntime } from '../../lib/providers/RuntimeProvider'
import { useCardImpression } from '../live/useCardImpression'
import { PostCard } from '../posts/PostCard'
import { postQueryKey } from '../posts/hooks/usePostActions'
import { EmptyState } from '../ui/EmptyState'
import { Skeleton } from '../ui/Skeleton'
import { profileCopy } from './copy'
import { useProfilePosts } from './hooks/useProfilePosts'
import { needsDetail } from './state/posts'

function ProfilePostItem({ view }: { readonly view: PostViewDto }) {
  const earth = useEarth()
  const { runtime } = useRuntime()
  const [visible, setVisible] = useState(false)
  const ref = useCardImpression(() => setVisible(true))
  const wantsDetail = needsDetail(view)
  const detail = useQuery({
    queryKey: postQueryKey(view.post.id),
    queryFn: () => earth.posts.get(view.post.id),
    enabled: runtime !== null && wantsDetail && visible,
  })
  const merged: PostViewDto = detail.data ?? view
  return (
    <div ref={ref}>
      <PostCard view={merged} context={{ source: 'profile' }} />
    </div>
  )
}

export function ProfilePosts({ profile }: { readonly profile: ProfileDto }) {
  const posts = useProfilePosts(profile)
  return (
    <section aria-label={profileCopy.now} className="flex flex-col hairline-t">
      <h2 className="px-screen-margin pt-4 pb-1 text-section">{profileCopy.now}</h2>
      {posts.loading ? (
        <div aria-hidden="true" className="flex flex-col gap-3 px-screen-margin py-4">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : posts.failed ? (
        <p role="status" className="px-screen-margin py-3 text-secondary text-text-secondary">
          {copy.couldntRefresh}
        </p>
      ) : posts.posts.length === 0 ? (
        <EmptyState title={profileCopy.noPostsYet} />
      ) : (
        <ol className="flex flex-col [&>*+*]:hairline-t">
          {posts.posts.map((view) => (
            <li key={view.post.id}>
              <ProfilePostItem view={view} />
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
