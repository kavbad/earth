/**
 * SCREEN 13 — Live Home list for the selected radius: `GET /api/live` cards in the server's
 * order (Friends rank, public eligibility per scope), refreshed every 30 s while on screen.
 * Cached cards stay while a refresh fails ("Couldn't refresh", spec §110); an empty radius says
 * so only when that is meaningful; a Visitor with public Lives off meets the claim sheet.
 */
import { FeatureFlag } from '@earth/config'
import type { LiveCardDto } from '@earth/domain'
import { colors, copy, space } from '@earth/ui'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, RefreshControl, StyleSheet, View, type ViewToken } from 'react-native'

import { useClaimGate } from '@/components/shell/ClaimSheet'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatusLine } from '@/components/ui/StatusLine'
import { roomCopy } from '@/features/rooms/copy'
import {
  IMPRESSION_THRESHOLD_PERCENT,
  LIVE_ROW_HEIGHT,
  markImpression,
} from '@/features/rooms/state/live'
import { lightTap } from '@/lib/haptics'
import {
  useAnalytics,
  useEarth,
  useFlags,
  useOnline,
  useRuntime,
  useScope,
  useSession,
} from '@/lib/providers'
import { roomRoute } from '@/lib/routes'

import { LiveCard } from './LiveCard'

export const LIVE_REFRESH_INTERVAL_MS = 30_000
export const LIVE_QUERY_KEY = 'live' as const
const SKELETON_ROWS = [0, 1, 2] as const
const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: IMPRESSION_THRESHOLD_PERCENT }

function keyExtractor(card: LiveCardDto): string {
  return card.id
}

function getItemLayout(_data: ArrayLike<LiveCardDto> | null | undefined, index: number) {
  return { length: LIVE_ROW_HEIGHT, offset: LIVE_ROW_HEIGHT * index, index }
}

function LiveSkeleton() {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {SKELETON_ROWS.map((row) => (
        <View key={row} style={styles.skeletonRow}>
          <Skeleton width={space[10]} height={space[10]} round />
          <View style={styles.skeletonLines}>
            <Skeleton width="55%" height={space[4]} />
            <Skeleton width="35%" height={space[3]} />
          </View>
        </View>
      ))}
    </View>
  )
}

export function LiveList() {
  const { runtime } = useRuntime()
  const earth = useEarth()
  const session = useSession()
  const flags = useFlags()
  const online = useOnline()
  const gate = useClaimGate()
  const analytics = useAnalytics()
  const router = useRouter()
  const { scope } = useScope('live')
  const seen = useRef(new Set<string>())

  const publicLiveOff = session.roleKind !== 'human' && !flags[FeatureFlag.PUBLIC_LIVE_ENABLED]
  const enabled = runtime !== null && session.status === 'ready' && !publicLiveOff
  const query = useQuery({
    queryKey: [LIVE_QUERY_KEY, scope, session.humanId],
    queryFn: () => earth.live.list(scope),
    enabled,
    refetchInterval: online ? LIVE_REFRESH_INTERVAL_MS : false,
    placeholderData: keepPreviousData,
  })

  useEffect(() => {
    if (!enabled) return
    analytics.track('feed_opened', { scope, surface: 'live', source: 'tab' })
  }, [analytics, enabled, scope])

  const data = query.data
  const cards: readonly LiveCardDto[] = useMemo(() => data?.cards ?? [], [data])

  const onOpen = useCallback(
    (card: LiveCardDto) => {
      lightTap()
      const position = cards.findIndex((candidate) => candidate.id === card.id)
      analytics.track('live_card_opened', { roomId: card.roomId, surface: 'live', scope, position })
      router.push(roomRoute(card.roomId))
    },
    [analytics, cards, router, scope],
  )

  // FlatList refuses a changing `onViewableItemsChanged`: one stable function reads the latest
  // scope and tracker through a ref (spec §97 `live_card_impression`, once per card per scope).
  const latest = useRef({ analytics, scope })
  useEffect(() => {
    latest.current = { analytics, scope }
  }, [analytics, scope])
  const [onViewableItemsChanged] = useState(
    () =>
      ({ viewableItems }: { viewableItems: ViewToken<LiveCardDto>[] }) => {
        const current = latest.current
        for (const token of viewableItems) {
          if (!token.isViewable || token.index === null) continue
          if (!markImpression(seen.current, current.scope, token.item.roomId)) continue
          current.analytics.track('live_card_impression', {
            roomId: token.item.roomId,
            surface: 'live',
            scope: current.scope,
            position: token.index,
            participantCount: token.item.participantCount,
          })
        }
      },
  )

  if (publicLiveOff) {
    return (
      <EmptyState
        title={roomCopy.publicLiveOff}
        action={
          <Button
            variant="primary"
            label={copy.claimYourPlace}
            onPress={() => gate.open('public_world')}
          />
        }
      />
    )
  }

  const refreshFailed = query.isError
  if (query.data === undefined) {
    if (refreshFailed) {
      return (
        <StatusLine
          message={online ? copy.couldntRefresh : copy.waitingForConnection}
          actionLabel={roomCopy.retry}
          onAction={() => void query.refetch()}
        />
      )
    }
    return <LiveSkeleton />
  }

  return (
    <FlatList
      data={cards}
      keyExtractor={keyExtractor}
      getItemLayout={getItemLayout}
      renderItem={({ item }) => <LiveCard card={item} onOpen={onOpen} />}
      windowSize={7}
      initialNumToRender={10}
      maxToRenderPerBatch={10}
      removeClippedSubviews
      onViewableItemsChanged={onViewableItemsChanged}
      viewabilityConfig={VIEWABILITY_CONFIG}
      refreshControl={
        <RefreshControl
          refreshing={query.isRefetching}
          onRefresh={() => void query.refetch()}
          tintColor={colors.textSecondary}
        />
      }
      ListHeaderComponent={
        refreshFailed ? (
          <StatusLine message={online ? copy.couldntRefresh : copy.waitingForConnection} />
        ) : null
      }
      ListEmptyComponent={<EmptyState title={roomCopy.nobodyLive(scope)} />}
      contentContainerStyle={styles.content}
      accessibilityLabel={copy.tabs.live}
    />
  )
}

const styles = StyleSheet.create({
  content: { paddingVertical: space[2] },
  skeletonRow: {
    height: LIVE_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingHorizontal: space[4],
  },
  skeletonLines: { flex: 1, gap: space[2] },
})
