'use client'

/**
 * SCREEN 13 — Live Home list for the selected radius: `GET /api/live` cards in the server's
 * order (Friends rank, public eligibility per scope). Cached cards stay while a refresh fails
 * ("Couldn't refresh", spec §110); an empty radius says so only when that is meaningful.
 */
import { FeatureFlag } from '@earth/config'
import type { LiveCardDto } from '@earth/domain'
import { copy } from '@earth/ui'
import { keepPreviousData, useQuery } from '@tanstack/react-query'

import { webCopy } from '../../lib/copy'
import { useAnalytics } from '../../lib/providers/AnalyticsProvider'
import { useFlags } from '../../lib/providers/FlagsProvider'
import { useEarth, useRuntime } from '../../lib/providers/RuntimeProvider'
import { useScope } from '../../lib/providers/ScopeProvider'
import { useSession } from '../../lib/providers/SessionProvider'
import { roomCopy } from '../rooms/copy'
import { useClaimGate } from '../shell/ClaimSheet'
import { LoadingState } from '../shell/LoadingState'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Skeleton } from '../ui/Skeleton'
import { LiveCard } from './LiveCard'

export const LIVE_REFRESH_INTERVAL_MS = 30_000
export const LIVE_QUERY_KEY = 'live' as const

function LiveSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex items-center gap-3 px-screen-margin py-3">
          <Skeleton className="size-10 rounded-avatar" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function LiveList() {
  const { runtime } = useRuntime()
  const earth = useEarth()
  const session = useSession()
  const flags = useFlags()
  const gate = useClaimGate()
  const analytics = useAnalytics()
  const { scope } = useScope('live')

  const publicLiveOff = session.roleKind !== 'human' && !flags[FeatureFlag.PUBLIC_LIVE_ENABLED]
  const query = useQuery({
    queryKey: [LIVE_QUERY_KEY, scope, session.humanId],
    queryFn: () => earth.live.list(scope),
    enabled: runtime !== null && session.status === 'ready' && !publicLiveOff,
    refetchInterval: LIVE_REFRESH_INTERVAL_MS,
    placeholderData: keepPreviousData,
  })

  if (publicLiveOff) {
    return (
      <EmptyState
        title={roomCopy.publicLiveOff}
        action={
          <Button variant="primary" onClick={() => gate.open('public_world')}>
            {copy.claimYourPlace}
          </Button>
        }
      />
    )
  }

  const cards: readonly LiveCardDto[] = query.data?.cards ?? []
  const refreshFailed = query.isError

  if (query.data === undefined) {
    if (refreshFailed) {
      return (
        <div className="flex flex-col items-start gap-2 px-screen-margin py-4">
          <p role="status" className="text-secondary text-text-secondary">
            {copy.couldntRefresh}
          </p>
          <Button variant="quiet" onClick={() => void query.refetch()}>
            {webCopy.retry}
          </Button>
        </div>
      )
    }
    return (
      <LoadingState>
        <LiveSkeleton />
      </LoadingState>
    )
  }

  return (
    <div className="fade-in flex flex-col py-2" key={scope}>
      {refreshFailed ? (
        <p role="status" className="px-screen-margin py-2 text-secondary text-text-secondary">
          {copy.couldntRefresh}
        </p>
      ) : null}
      {cards.length === 0 ? (
        <EmptyState title={roomCopy.nobodyLive(scope)} />
      ) : (
        <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2" aria-label={copy.tabs.live}>
          {cards.map((card, index) => (
            <li key={card.id}>
              <LiveCard
                card={card}
                onSeen={() =>
                  analytics.track('live_card_impression', {
                    roomId: card.roomId,
                    surface: 'live',
                    scope,
                    position: index,
                    participantCount: card.participantCount,
                  })
                }
                onOpen={() =>
                  analytics.track('live_card_opened', {
                    roomId: card.roomId,
                    surface: 'live',
                    scope,
                    position: index,
                  })
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
