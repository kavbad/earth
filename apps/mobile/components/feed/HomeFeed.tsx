/**
 * SCREEN 01–05 — Home: the `earth` wordmark with Search and Notifications, the radius control, a
 * subtitle for Neighborhood / City (with the city switch), the presence row only when there is
 * state, then the feed for the radius — cached per radius, so switching crossfades in place
 * (spec §95). Visitors browse World; every other radius and every action opens the claim sheet
 * (spec §43). "Waiting for connection" comes from the tab shell (spec §107).
 */
import { FeatureFlag } from '@earth/config'
import { colors, copy, motion } from '@earth/ui'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated'

import { RadiusControl } from '@/components/shell/RadiusControl'
import { Button, EmptyState, IconButton } from '@/components/ui'
import { feedCopy } from '@/features/feed/copy'
import { useAreaName } from '@/features/feed/hooks/useAreaName'
import { useFeed } from '@/features/feed/hooks/useFeed'
import { useMyProfile } from '@/features/feed/hooks/useProfile'
import { useUnreadCount } from '@/features/feed/hooks/useUnreadCount'
import { NOTIFICATIONS_ROUTE, searchHref } from '@/features/feed/routes'
import { useFeedShell, useHomeScope } from '@/features/feed/shell'
import {
  areaIdForScope,
  cityChoices,
  feedOpenSource,
  feedSubtitle,
  feedUiReducer,
  initialFeedUiState,
  shouldShowAddPeople,
  viewerKeyFor,
} from '@/features/feed/state/feed'

import { CitySwitch } from './CitySwitch'
import { FeedList } from './FeedList'
import { HomeHeader } from './HomeHeader'
import { NotificationsButton } from './NotificationsButton'
import { PresenceRow } from './PresenceRow'

export function HomeFeed() {
  const shell = useFeedShell()
  const { track, isHuman, sessionStatus, flags, openClaim } = shell
  const router = useRouter()
  const { scope, availability } = useHomeScope()
  const viewerKey = viewerKeyFor(shell.viewerId)
  const [ui, dispatch] = useReducer(feedUiReducer, viewerKey, initialFeedUiState)
  useEffect(() => {
    dispatch({ type: 'viewer_changed', viewerKey })
  }, [viewerKey])

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

  const context = shell.me?.context ?? null
  const homeCityName = useAreaName(context?.homeCityId ?? null)
  const choices = useMemo(() => cityChoices(context, homeCityName), [context, homeCityName])
  const myProfile = useMyProfile()
  const showAddPeople = shouldShowAddPeople({
    isHuman,
    scope,
    friendCount: myProfile?.counts.friends ?? null,
  })
  const unread = useUnreadCount()

  // feed_opened on first render and on every radius change; public_world_viewed for Visitors.
  const opened = useRef(false)
  useEffect(() => {
    if (sessionStatus !== 'ready') return
    track('feed_opened', { scope, surface: 'home', source: feedOpenSource(opened.current, false) })
    opened.current = true
    if (!isHuman && scope === 'world') track('public_world_viewed', { surface: 'home', scope })
  }, [isHuman, scope, sessionStatus, track])

  const { refresh } = feed
  const refreshManually = useCallback(() => {
    track('feed_opened', { scope, surface: 'home', source: feedOpenSource(true, true) })
    void refresh()
  }, [refresh, scope, track])
  const onHidden = useCallback((postId: string) => dispatch({ type: 'hide', postId }), [])

  const subtitle =
    scope === 'city' && choices.length >= 2 ? (
      <CitySwitch
        choices={choices}
        selected={ui.cityAreaId}
        fallbackName={feed.view.areaName}
        onSelect={(next) => dispatch({ type: 'select_city', areaId: next })}
      />
    ) : (
      feedSubtitle({
        scope,
        areaName: feed.view.areaName,
        context,
        choiceCount: choices.length,
      })
    )

  return (
    <View style={styles.screen} accessibilityLabel={copy.tabs.home}>
      <HomeHeader
        trailing={
          <>
            <IconButton
              name="search"
              label={feedCopy.openSearch}
              onPress={() => router.push(searchHref())}
            />
            {isHuman ? (
              <NotificationsButton
                unreadCount={unread}
                onPress={() => router.push(NOTIFICATIONS_ROUTE)}
              />
            ) : null}
          </>
        }
        {...(subtitle === undefined ? {} : { subtitle })}
        presence={
          feed.view.presence.length > 0 ? <PresenceRow items={feed.view.presence} /> : undefined
        }
      >
        <RadiusControl surface="home" />
      </HomeHeader>
      {publicWorldOff ? (
        <EmptyState
          title={feedCopy.publicWorldOff}
          action={<Button label={copy.claimYourPlace} onPress={() => openClaim('public_world')} />}
        />
      ) : (
        // Keyed by radius: the old list fades out as the new one fades in (spec §95 crossfade).
        <Animated.View
          key={scope}
          entering={FadeIn.duration(motion.duration.base)}
          exiting={FadeOut.duration(motion.duration.base)}
          style={styles.fill}
        >
          <FeedList
            feed={feed}
            scope={scope}
            showAddPeople={showAddPeople}
            onHidden={onHidden}
            onRefresh={refreshManually}
          />
        </Animated.View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  fill: { flex: 1 },
})
