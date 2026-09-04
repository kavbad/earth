/**
 * The Home list for one radius (SCREEN 01–05; spec §92, §110): posts and Lives in the server's
 * order, separated by space and a hairline — never wrapped in thick cards — with cursor infinite
 * scroll (`onEndReached`), pull-to-refresh, cached cards kept through a failed refresh with an
 * inline "Couldn't refresh", the compose entry and the zero-friends row at the top, and
 * once-per-card impressions. Rows have their own heights (text, media), so the list measures
 * them; memoised rows and a tight window keep scrolling smooth.
 */
import type { LiveCardDto, PostId, Scope } from '@earth/domain'
import { borderWidth, colors, copy, space, spacing } from '@earth/ui'
import { useRouter } from 'expo-router'
import { memo, useCallback, useMemo } from 'react'
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native'

import { LiveCard } from '@/components/live/LiveCard'
import { PostCard } from '@/components/posts/PostCard'
import { Button, EmptyState, Skeleton, Spinner, StatusLine, text } from '@/components/ui'
import { feedCopy } from '@/features/feed/copy'
import type { FeedController } from '@/features/feed/hooks/useFeed'
import { useImpressions } from '@/features/feed/hooks/useImpressions'
import { roomRoute } from '@/features/feed/routes'
import { useFeedShell } from '@/features/feed/shell'
import { type FeedRow, authorRelationFor, feedRows } from '@/features/feed/state/feed'
import { lightTap } from '@/lib/haptics'

import { AddPeopleRow } from './AddPeopleRow'
import { ComposeEntry } from './ComposeEntry'

export interface FeedListProps {
  readonly feed: FeedController
  readonly scope: Scope
  /** SCREEN 02 zero-friends member state. */
  readonly showAddPeople: boolean
  readonly onHidden: (postId: PostId) => void
  /** Manual refresh (pull, the inline control); the caller tracks `feed_opened`. */
  readonly onRefresh: () => void
}

const SKELETON_ROWS = [0, 1, 2] as const
const END_REACHED_THRESHOLD = 0.6

function keyExtractor(row: FeedRow): string {
  return row.key
}

export function FeedSkeleton() {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {SKELETON_ROWS.map((row) => (
        <View key={row} style={styles.skeletonRow}>
          <Skeleton width={space[10]} height={space[10]} round />
          <View style={styles.skeletonLines}>
            <Skeleton width="33%" height={space[4]} />
            <Skeleton width="85%" height={space[4]} />
            <Skeleton height={space[16] + space[16]} />
          </View>
        </View>
      ))}
    </View>
  )
}

function Separator() {
  return <View style={styles.separator} />
}

interface RowProps {
  readonly row: FeedRow
  readonly scope: Scope
  readonly onOpenPost: (row: FeedRow) => void
  readonly onOpenLive: (row: FeedRow, card: LiveCardDto) => void
  readonly onHidden: (postId: PostId) => void
}

function FeedRowView({ row, scope, onOpenPost, onOpenLive, onHidden }: RowProps) {
  const card = row.card
  if (card.kind === 'live') {
    return (
      <View style={styles.liveRow}>
        <LiveCard card={card} onOpen={(opened) => onOpenLive(row, opened)} />
      </View>
    )
  }
  return (
    <PostCard
      view={card}
      context={{ source: 'home', scope, position: row.position }}
      onOpen={() => onOpenPost(row)}
      onHidden={onHidden}
    />
  )
}

const FeedRowItem = memo(FeedRowView)

export function FeedList({ feed, scope, showAddPeople, onHidden, onRefresh }: FeedListProps) {
  const shell = useFeedShell()
  const { track, viewerId, online } = shell
  const router = useRouter()
  const rows = useMemo(() => feedRows(feed.view.cards), [feed.view.cards])

  const onSeen = useCallback(
    (row: FeedRow) => {
      const card = row.card
      if (card.kind === 'live') {
        track('live_card_impression', {
          roomId: card.roomId,
          surface: 'home',
          scope,
          position: row.position,
          participantCount: card.participantCount,
        })
        return
      }
      track('post_impression', {
        postId: card.id,
        scope,
        audience: card.post.audience,
        position: row.position,
        authorRelation: authorRelationFor(viewerId, card.author.humanId),
      })
    },
    [scope, track, viewerId],
  )
  const impressions = useImpressions<FeedRow>(keyExtractor, onSeen)

  const onOpenPost = useCallback(
    (row: FeedRow) => {
      track('post_opened', { postId: row.card.id as PostId, scope, source: 'home' })
    },
    [scope, track],
  )
  const onOpenLive = useCallback(
    (row: FeedRow, card: LiveCardDto) => {
      lightTap()
      track('live_card_opened', {
        roomId: card.roomId,
        surface: 'home',
        scope,
        position: row.position,
      })
      router.push(roomRoute(card.roomId))
    },
    [router, scope, track],
  )

  const renderItem = useCallback(
    ({ item }: { item: FeedRow }) => (
      <FeedRowItem
        row={item}
        scope={scope}
        onOpenPost={onOpenPost}
        onOpenLive={onOpenLive}
        onHidden={onHidden}
      />
    ),
    [scope, onOpenPost, onOpenLive, onHidden],
  )

  const onEndReached = useCallback(() => {
    if (feed.hasMore) feed.loadMore()
  }, [feed])

  const header = (
    <View>
      {feed.refreshFailed ? (
        <StatusLine
          message={online ? copy.couldntRefresh : copy.waitingForConnection}
          actionLabel={feedCopy.refresh}
          onAction={onRefresh}
        />
      ) : null}
      <ComposeEntry scope={scope} />
      {showAddPeople ? <AddPeopleRow /> : null}
    </View>
  )

  const empty = feed.loading ? (
    <FeedSkeleton />
  ) : feed.failed ? (
    <StatusLine
      message={online ? copy.couldntRefresh : copy.waitingForConnection}
      actionLabel={feedCopy.retry}
      onAction={onRefresh}
    />
  ) : feed.enabled ? (
    <EmptyState title={feedCopy.nothingHereYet(scope)} />
  ) : null

  const footer = feed.loadingMore ? (
    <Spinner label={feedCopy.loadingMore} />
  ) : feed.hasMore && rows.length > 0 ? (
    <View style={styles.more}>
      <Button variant="quiet" label={feedCopy.loadingMore} onPress={feed.loadMore} />
    </View>
  ) : rows.length > 0 ? (
    <Text style={[text.secondary, text.muted, styles.end]}>{feedCopy.endOfFeed}</Text>
  ) : (
    <View style={styles.footerSpace} />
  )

  return (
    <FlatList
      data={rows}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      ItemSeparatorComponent={Separator}
      ListHeaderComponent={header}
      ListEmptyComponent={empty}
      ListFooterComponent={footer}
      onEndReached={onEndReached}
      onEndReachedThreshold={END_REACHED_THRESHOLD}
      onViewableItemsChanged={impressions.onViewableItemsChanged}
      viewabilityConfig={impressions.viewabilityConfig}
      refreshControl={
        <RefreshControl
          refreshing={feed.refreshing}
          onRefresh={onRefresh}
          tintColor={colors.textSecondary}
          title={feedCopy.refreshing}
          titleColor={colors.textSecondary}
        />
      }
      windowSize={7}
      initialNumToRender={6}
      maxToRenderPerBatch={6}
      updateCellsBatchingPeriod={50}
      removeClippedSubviews
      contentContainerStyle={styles.content}
      accessibilityLabel={feedCopy.feedList}
    />
  )
}

const styles = StyleSheet.create({
  content: { paddingBottom: space[6] },
  separator: {
    marginHorizontal: spacing.screenMargin,
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: colors.separator,
  },
  liveRow: { paddingVertical: space[2] },
  skeletonRow: {
    flexDirection: 'row',
    gap: space[3],
    paddingHorizontal: spacing.screenMargin,
    paddingVertical: space[4],
  },
  skeletonLines: { flex: 1, gap: space[3] },
  more: { alignItems: 'center', paddingVertical: space[2] },
  end: { textAlign: 'center', paddingHorizontal: spacing.screenMargin, paddingVertical: space[6] },
  footerSpace: { height: space[4] },
})
