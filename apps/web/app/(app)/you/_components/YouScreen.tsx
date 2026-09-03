'use client'

/**
 * SCREEN 24 — You: your own profile (avatar, name, handle, city), your posts, friend / follow
 * counts quietly, Settings, and the "Your Earth" scaffold that opens the map on your home city
 * with your Moments. No lifetime product yet (spec §133).
 */
import type { FeedPostCardDto } from '@earth/domain'
import { copy, formatHandle, relativeTime } from '@earth/ui'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useEffect, useRef } from 'react'

import { earthRoute } from '../../../../components/map/routes'
import { PageContainer } from '../../../../components/shell/PageContainer'
import { ScreenHeader } from '../../../../components/shell/ScreenHeader'
import { useClaimGate } from '../../../../components/shell/ClaimSheet'
import { Avatar } from '../../../../components/ui/Avatar'
import { Button } from '../../../../components/ui/Button'
import { EmptyState } from '../../../../components/ui/EmptyState'
import { Icon } from '../../../../components/ui/Icon'
import { List, ListRow } from '../../../../components/ui/ListRow'
import { Skeleton } from '../../../../components/ui/Skeleton'
import { webCopy } from '../../../../lib/copy'
import { useAnalytics } from '../../../../lib/providers/AnalyticsProvider'
import { useEarth, useRuntime } from '../../../../lib/providers/RuntimeProvider'
import { useSession } from '../../../../lib/providers/SessionProvider'
import { ROUTES } from '../../../../lib/routes'
import { youCopy } from '../_lib/copy'
import { YOU_ROUTES, postRoute } from '../_lib/routes'

export const YOU_PROFILE_QUERY_KEY = 'you-profile' as const
export const YOU_POSTS_QUERY_KEY = 'you-posts' as const

/** Own posts out of the Friends feed (the pool includes the viewer's own posts, DB_API §4). */
export function ownPosts(
  cards: readonly { kind: string }[],
  humanId: string | null,
): FeedPostCardDto[] {
  if (humanId === null) return []
  return cards.filter(
    (card): card is FeedPostCardDto =>
      card.kind === 'post' && (card as FeedPostCardDto).author.humanId === humanId,
  )
}

function ProfileSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3 px-screen-margin py-6">
      <Skeleton className="size-24 rounded-avatar" />
      <Skeleton className="h-6 w-1/2" />
      <Skeleton className="h-4 w-1/3" />
    </div>
  )
}

export function YouScreen() {
  const { runtime } = useRuntime()
  const earth = useEarth()
  const session = useSession()
  const analytics = useAnalytics()
  const gate = useClaimGate()
  const identity = session.identity
  const humanId = session.humanId
  const isHuman = session.roleKind === 'human'

  const profile = useQuery({
    queryKey: [YOU_PROFILE_QUERY_KEY, identity?.handle ?? null],
    queryFn: () => earth.social.profile(identity?.handle ?? ''),
    enabled: runtime !== null && isHuman && identity !== null,
    staleTime: 60_000,
  })
  const posts = useQuery({
    queryKey: [YOU_POSTS_QUERY_KEY, humanId],
    queryFn: () => earth.feed.page('friends'),
    enabled: runtime !== null && isHuman,
    staleTime: 30_000,
  })

  const viewed = useRef(false)
  useEffect(() => {
    if (viewed.current || humanId === null) return
    viewed.current = true
    analytics.track('profile_viewed', {
      profileHumanId: humanId,
      relation: 'self',
      source: 'profile',
    })
  }, [humanId, analytics])

  if (session.status === 'loading') {
    return (
      <>
        <ScreenHeader title={copy.tabs.you} />
        <PageContainer>
          <ProfileSkeleton />
        </PageContainer>
      </>
    )
  }

  if (!isHuman || identity === null) {
    return (
      <>
        <ScreenHeader title={copy.tabs.you} />
        <PageContainer>
          <EmptyState
            title={session.roleKind === 'claiming' ? youCopy.finishClaim : youCopy.notOnEarthYet}
            action={
              session.roleKind === 'claiming' ? (
                <Link href={ROUTES.claim} className="text-body text-earth-accent">
                  {youCopy.finishClaim}
                </Link>
              ) : (
                <Button variant="primary" onClick={() => gate.open('profile')}>
                  {copy.claimYourPlace}
                </Button>
              )
            }
          />
        </PageContainer>
      </>
    )
  }

  const counts = profile.data?.counts ?? null
  const cards = posts.data?.cards ?? []
  const mine = ownPosts(cards, humanId)

  return (
    <>
      <ScreenHeader
        title={copy.tabs.you}
        trailing={
          <Link
            href={YOU_ROUTES.settings}
            className="flex min-h-touch-target items-center px-2 text-body text-text-secondary"
          >
            {copy.settings.title}
          </Link>
        }
      />
      <PageContainer>
        <section aria-label={copy.tabs.you} className="flex flex-col gap-3 px-screen-margin py-6">
          <Avatar name={identity.displayName} src={identity.avatarUrl} size="profile" decorative />
          <div className="flex flex-col">
            <h2 className="text-title">{identity.displayName}</h2>
            <p className="text-secondary text-text-secondary">{formatHandle(identity.handle)}</p>
            {identity.cityName !== null ? (
              <p className="text-secondary text-text-secondary">{identity.cityName}</p>
            ) : null}
          </div>
          {identity.bio !== null && identity.bio !== '' ? (
            <p className="text-body">{identity.bio}</p>
          ) : null}
          {counts !== null ? (
            <p className="text-meta text-text-secondary">
              {youCopy.counts(counts.friends, counts.followers, counts.following)}
            </p>
          ) : null}
        </section>

        <List>
          <Link href={earthRoute({ you: true })} className="block">
            <ListRow
              leading={<Icon name="earth" />}
              title={copy.yourEarth}
              subtitle={youCopy.yourEarthLine}
              trailing={<Icon name="chevron" size="small" />}
            />
          </Link>
          <Link href={YOU_ROUTES.settings} className="block">
            <ListRow title={copy.settings.title} trailing={<Icon name="chevron" size="small" />} />
          </Link>
        </List>

        <section aria-label={youCopy.posts} className="flex flex-col py-6">
          <h3 className="px-screen-margin text-section">{youCopy.posts}</h3>
          {posts.isError && posts.data === undefined ? (
            <div className="flex items-center gap-3 px-screen-margin py-3">
              <p role="status" className="text-secondary text-text-secondary">
                {copy.couldntRefresh}
              </p>
              <Button variant="quiet" onClick={() => void posts.refetch()}>
                {webCopy.retry}
              </Button>
            </div>
          ) : posts.data === undefined ? (
            <div aria-hidden="true" className="flex flex-col gap-3 px-screen-margin py-4">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : mine.length === 0 ? (
            <EmptyState title={youCopy.noPostsYet} className="py-4" />
          ) : (
            <ul className="flex flex-col" aria-label={youCopy.posts}>
              {mine.map((card) => (
                <li key={card.id} className="hairline-t first:border-t-0">
                  <Link
                    href={postRoute(card.post.id)}
                    className="block px-screen-margin py-feed-gap-min hover:bg-subtle-fill"
                  >
                    {card.post.text !== null && card.post.text !== '' ? (
                      <p className="text-body whitespace-pre-wrap">{card.post.text}</p>
                    ) : null}
                    {card.media.length > 0 ? (
                      <div className="mt-2 flex gap-2 overflow-x-auto">
                        {card.media.map((media) =>
                          media.mediaType === 'image' ? (
                            // eslint-disable-next-line @next/next/no-img-element -- media from storage, no optimisation layer
                            <img
                              key={media.id}
                              src={media.url}
                              alt=""
                              className="h-40 max-w-full rounded-small bg-subtle-fill object-cover"
                            />
                          ) : (
                            <span key={media.id} className="text-meta text-text-secondary">
                              {media.mediaType}
                            </span>
                          ),
                        )}
                      </div>
                    ) : null}
                    <p className="mt-2 text-meta text-text-secondary">
                      {relativeTime(card.post.createdAt)}
                      {card.place !== null ? ` · ${card.place.name}` : ''}
                      {' · '}
                      {copy.audiences[card.post.audience]}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </PageContainer>
    </>
  )
}
