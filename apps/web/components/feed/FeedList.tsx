'use client'

/**
 * The Home list for one radius (SCREEN 01–05; spec §92, §110): posts and Lives in the server's
 * order, separated by space and a hairline — never wrapped in thick cards — with infinite
 * scroll on the keyset cursor and cached cards kept through a failed refresh.
 */
import type { PostId, Scope, ViewerRelation } from '@earth/domain'
import { copy } from '@earth/ui'

import { webCopy } from '../../lib/copy'
import { useAnalytics } from '../../lib/providers/AnalyticsProvider'
import { useSession } from '../../lib/providers/SessionProvider'
import { LiveCard } from '../live/LiveCard'
import { PostCard } from '../posts/PostCard'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Skeleton } from '../ui/Skeleton'
import { Spinner } from '../ui/Spinner'
import { feedCopy } from './copy'
import type { FeedController } from './hooks/useFeed'
import { useInfiniteScroll } from './hooks/useInfiniteScroll'

export interface FeedListProps {
  readonly feed: FeedController
  readonly scope: Scope
  readonly onHidden: (postId: PostId) => void
}

export function FeedSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex gap-3 px-screen-margin py-4">
          <Skeleton className="size-10 rounded-avatar" />
          <div className="flex flex-1 flex-col gap-3">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-40 w-full" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function FeedList({ feed, scope, onHidden }: FeedListProps) {
  const analytics = useAnalytics()
  const session = useSession()
  const sentinel = useInfiniteScroll(feed.loadMore)
  const { cards } = feed.view

  if (feed.loading) return <FeedSkeleton />
  if (feed.failed) {
    return (
      <div className="flex flex-col items-start gap-2 px-screen-margin py-4">
        <p role="status" className="text-secondary text-text-secondary">
          {copy.couldntRefresh}
        </p>
        <Button variant="quiet" onClick={() => void feed.refresh()}>
          {webCopy.retry}
        </Button>
      </div>
    )
  }

  const relationFor = (authorHumanId: string): ViewerRelation =>
    session.humanId === authorHumanId ? 'self' : 'other'

  return (
    <div className="flex flex-col">
      {cards.length === 0 ? (
        <EmptyState title={feedCopy.nothingHereYet(scope)} />
      ) : (
        <ol aria-label={feedCopy.feedList} className="flex flex-col [&>*+*]:hairline-t">
          {cards.map((card, position) =>
            card.kind === 'live' ? (
              <li key={card.id} className="py-2">
                <LiveCard
                  card={card}
                  onSeen={() =>
                    analytics.track('live_card_impression', {
                      roomId: card.roomId,
                      surface: 'home',
                      scope,
                      position,
                      participantCount: card.participantCount,
                    })
                  }
                  onOpen={() =>
                    analytics.track('live_card_opened', {
                      roomId: card.roomId,
                      surface: 'home',
                      scope,
                      position,
                    })
                  }
                />
              </li>
            ) : (
              <li key={card.id}>
                <PostCard
                  view={card}
                  context={{ source: 'home', scope, position }}
                  onSeen={() =>
                    analytics.track('post_impression', {
                      postId: card.id,
                      scope,
                      audience: card.post.audience,
                      position,
                      authorRelation: relationFor(card.author.humanId),
                    })
                  }
                  onOpen={() =>
                    analytics.track('post_opened', { postId: card.id, scope, source: 'home' })
                  }
                  onHidden={onHidden}
                />
              </li>
            ),
          )}
        </ol>
      )}
      {feed.hasMore ? (
        <div ref={sentinel} className="flex min-h-16 items-center justify-center py-4">
          {feed.loadingMore ? (
            <Spinner label={feedCopy.loadingMore} />
          ) : (
            <Button variant="quiet" onClick={feed.loadMore}>
              {feedCopy.loadingMore}
            </Button>
          )}
        </div>
      ) : cards.length > 0 ? (
        <p className="px-screen-margin py-6 text-center text-secondary text-text-secondary">
          {feedCopy.endOfFeed}
        </p>
      ) : null}
    </div>
  )
}
