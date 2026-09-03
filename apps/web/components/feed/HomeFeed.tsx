'use client'

/**
 * SCREEN 01–05 — Home: the `earth` wordmark, the radius control, a subtitle for Neighborhood /
 * City (with the city switch), the presence row only when there is state, then the feed for the
 * radius — cached per radius so switching crossfades in place. Visitors browse World; every
 * other radius and every action opens the claim sheet (spec §43).
 */
import { FeatureFlag } from '@earth/config'
import { copy, space } from '@earth/ui'
import { useEffect, useMemo, useReducer, useRef } from 'react'

import { useAnalytics } from '../../lib/providers/AnalyticsProvider'
import { useFlags } from '../../lib/providers/FlagsProvider'
import { useScope } from '../../lib/providers/ScopeProvider'
import { useSession } from '../../lib/providers/SessionProvider'
import { useMyProfile } from '../profile/hooks/useProfile'
import { useClaimGate } from '../shell/ClaimSheet'
import { PageContainer } from '../shell/PageContainer'
import { RadiusControl } from '../shell/RadiusControl'
import { ScreenHeader } from '../shell/ScreenHeader'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Spinner } from '../ui/Spinner'
import { AddPeopleRow } from './AddPeopleRow'
import { CitySwitch } from './CitySwitch'
import { ComposeEntry } from './ComposeEntry'
import { FeedList } from './FeedList'
import { PresenceRow } from './PresenceRow'
import { feedCopy } from './copy'
import { useAreaName } from './hooks/useAreaName'
import { useFeed } from './hooks/useFeed'
import { usePullToRefresh } from './hooks/usePullToRefresh'
import {
  areaIdForScope,
  cityChoices,
  feedOpenSource,
  feedUiReducer,
  initialFeedUiState,
  shouldShowAddPeople,
  viewerKeyFor,
} from './state/feed'

/** The pull-to-refresh indicator's height — one 8 pt step, from the spacing scale (§91). */
const PULL_INDICATOR_HEIGHT = space[10]

export function HomeFeed() {
  const session = useSession()
  const flags = useFlags()
  const gate = useClaimGate()
  const analytics = useAnalytics()
  const { scope, availability } = useScope('home')
  const viewerKey = viewerKeyFor(session.humanId)
  const [ui, dispatch] = useReducer(feedUiReducer, viewerKey, initialFeedUiState)
  useEffect(() => dispatch({ type: 'viewer_changed', viewerKey }), [viewerKey])

  const isHuman = session.roleKind === 'human'
  const publicWorldOff = !isHuman && !flags[FeatureFlag.PUBLIC_WORLD_ENABLED]
  const scopeOpen = availability[scope] === 'available'
  const hidden = useMemo(() => new Set(ui.hiddenPostIds), [ui.hiddenPostIds])
  const areaId = areaIdForScope(scope, ui.cityAreaId)
  const feed = useFeed({
    scope,
    areaId,
    hiddenPostIds: hidden,
    enabled: scopeOpen && !publicWorldOff,
  })

  const context = session.me?.context ?? null
  const homeCityName = useAreaName(context?.homeCityId ?? null)
  const choices = useMemo(() => cityChoices(context, homeCityName), [context, homeCityName])
  const myProfile = useMyProfile()
  const showAddPeople = shouldShowAddPeople({
    isHuman,
    scope,
    friendCount: myProfile?.counts.friends ?? null,
  })

  // feed_opened on first render and on every radius change; public_world_viewed for Visitors.
  const opened = useRef(false)
  useEffect(() => {
    if (session.status !== 'ready') return
    analytics.track('feed_opened', {
      scope,
      surface: 'home',
      source: feedOpenSource(opened.current, false),
    })
    opened.current = true
    if (!isHuman && scope === 'world') {
      analytics.track('public_world_viewed', { surface: 'home', scope })
    }
  }, [analytics, isHuman, scope, session.status])

  const refreshManually = () => {
    analytics.track('feed_opened', { scope, surface: 'home', source: feedOpenSource(true, true) })
    void feed.refresh()
  }
  const pull = usePullToRefresh(refreshManually, feed.enabled && !feed.loading)

  const subtitle =
    scope === 'neighborhood'
      ? (feed.view.areaName ?? context?.currentAreaName ?? undefined)
      : scope === 'city' && choices.length < 2
        ? (feed.view.areaName ?? context?.currentCityName ?? undefined)
        : undefined

  return (
    <>
      <ScreenHeader
        {...(subtitle === undefined ? {} : { subtitle })}
        presence={
          feed.view.presence.length > 0 ? <PresenceRow items={feed.view.presence} /> : undefined
        }
      >
        <RadiusControl surface="home" />
        {scope === 'city' && choices.length >= 2 ? (
          <CitySwitch
            choices={choices}
            selected={ui.cityAreaId}
            fallbackName={feed.view.areaName}
            onSelect={(next) => dispatch({ type: 'select_city', areaId: next })}
          />
        ) : null}
      </ScreenHeader>
      <PageContainer>
        <div {...pull.bind} className="flex flex-col">
          <div
            aria-hidden={!pull.armed && !feed.refreshing}
            role="status"
            className="flex items-center justify-center overflow-hidden transition-[height] duration-fast ease-standard"
            style={{
              height: feed.refreshing
                ? PULL_INDICATOR_HEIGHT
                : pull.offset > 0
                  ? Math.min(pull.offset, PULL_INDICATOR_HEIGHT)
                  : 0,
            }}
          >
            {feed.refreshing ? (
              <Spinner label={feedCopy.refreshing} />
            ) : pull.armed ? (
              <span className="text-meta text-text-secondary">{feedCopy.refresh}</span>
            ) : null}
          </div>
          {publicWorldOff ? (
            <EmptyState
              title={feedCopy.publicWorldOff}
              action={
                <Button variant="primary" onClick={() => gate.open('public_world')}>
                  {copy.claimYourPlace}
                </Button>
              }
            />
          ) : (
            <div className="fade-in flex flex-col" key={scope}>
              {feed.refreshFailed ? (
                <div className="flex items-center justify-between gap-2 px-screen-margin py-2 text-secondary text-text-secondary">
                  <span role="status">{copy.couldntRefresh}</span>
                  <button
                    type="button"
                    onClick={refreshManually}
                    className="min-h-touch-target rounded-small px-2 text-secondary text-text-primary"
                  >
                    {feedCopy.refresh}
                  </button>
                </div>
              ) : null}
              <ComposeEntry scope={scope} />
              {showAddPeople ? <AddPeopleRow /> : null}
              <FeedList
                feed={feed}
                scope={scope}
                onHidden={(postId) => dispatch({ type: 'hide', postId })}
              />
            </div>
          )}
        </div>
      </PageContainer>
    </>
  )
}
