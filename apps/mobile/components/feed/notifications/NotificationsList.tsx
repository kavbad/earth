/**
 * SCREEN 23 — one list, no tabs, in the server's order (priority rank, then newest; likes lower).
 * Rows are marked read as they come on screen; realtime inserts refresh the list, polling covers
 * a degraded channel. Cached rows survive a failed refresh (spec §110); Visitors meet the claim
 * sheet (spec §43).
 */
import { colors, copy, space, spacing } from '@earth/ui'
import { useRouter } from 'expo-router'
import { useCallback } from 'react'
import { FlatList, RefreshControl, StyleSheet, View } from 'react-native'

import {
  Button,
  EmptyState,
  IconButton,
  ScreenHeader,
  Skeleton,
  Spinner,
  StatusLine,
} from '@/components/ui'
import { feedCopy } from '@/features/feed/copy'
import { useBack } from '@/features/feed/hooks/useBack'
import { useImpressions } from '@/features/feed/hooks/useImpressions'
import { useNotifications } from '@/features/feed/hooks/useNotifications'
import { useFeedShell } from '@/features/feed/shell'
import {
  NOTIFICATION_ROW_HEIGHT,
  type NotificationRow as Row,
  destinationHref,
} from '@/features/feed/state/notifications'
import { lightTap } from '@/lib/haptics'

import { NotificationRow } from './NotificationRow'

const SKELETON_ROWS = [0, 1, 2, 3] as const

function keyExtractor(row: Row): string {
  return row.id
}

function getItemLayout(_data: ArrayLike<Row> | null | undefined, index: number) {
  return { length: NOTIFICATION_ROW_HEIGHT, offset: NOTIFICATION_ROW_HEIGHT * index, index }
}

function RowsSkeleton() {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {SKELETON_ROWS.map((row) => (
        <View key={row} style={styles.skeletonRow}>
          <Skeleton width={space[10]} height={space[10]} round />
          <View style={styles.skeletonLines}>
            <Skeleton width="50%" height={space[4]} />
            <Skeleton width="33%" height={space[3]} />
          </View>
        </View>
      ))}
    </View>
  )
}

export function NotificationsList() {
  const shell = useFeedShell()
  const router = useRouter()
  const back = useBack()
  const notifications = useNotifications()
  const { markRead, acceptFriend } = notifications

  // Rows are marked read once they have been on screen (spec SCREEN 23: no unread chore).
  const onSeen = useCallback(
    (row: Row) => {
      if (row.unread) markRead(row.id)
    },
    [markRead],
  )
  const impressions = useImpressions<Row>(keyExtractor, onSeen)

  const onOpen = useCallback(
    (row: Row) => {
      markRead(row.id)
      const href = destinationHref(row.destination)
      if (href === null) return
      lightTap()
      router.push(href)
    },
    [markRead, router],
  )

  const renderItem = useCallback(
    ({ item }: { item: Row }) => (
      <NotificationRow row={item} onAccept={acceptFriend} onOpen={onOpen} />
    ),
    [acceptFriend, onOpen],
  )

  const visitor = shell.sessionStatus === 'ready' && !shell.isHuman
  const offlineLine = shell.online ? copy.couldntRefresh : copy.waitingForConnection

  return (
    <View style={styles.screen}>
      <ScreenHeader
        title={copy.notificationsTitle}
        leading={<IconButton name="back" label={feedCopy.back} onPress={back} />}
      />
      {!shell.online ? <StatusLine message={copy.waitingForConnection} banner /> : null}
      {visitor ? (
        <EmptyState
          title={feedCopy.notificationsFor}
          action={
            <Button label={copy.claimYourPlace} onPress={() => shell.openClaim('public_world')} />
          }
        />
      ) : notifications.loading || shell.sessionStatus === 'loading' ? (
        <RowsSkeleton />
      ) : notifications.failed ? (
        <StatusLine
          message={offlineLine}
          actionLabel={feedCopy.retry}
          onAction={notifications.refresh}
        />
      ) : (
        <FlatList
          data={notifications.rows}
          keyExtractor={keyExtractor}
          getItemLayout={getItemLayout}
          renderItem={renderItem}
          onEndReached={notifications.loadMore}
          onEndReachedThreshold={0.5}
          onViewableItemsChanged={impressions.onViewableItemsChanged}
          viewabilityConfig={impressions.viewabilityConfig}
          refreshControl={
            <RefreshControl
              refreshing={notifications.refreshing}
              onRefresh={notifications.refresh}
              tintColor={colors.textSecondary}
            />
          }
          ListHeaderComponent={
            notifications.refreshFailed ? <StatusLine message={offlineLine} /> : null
          }
          ListEmptyComponent={<EmptyState title={feedCopy.nothingYet} />}
          ListFooterComponent={notifications.loadingMore ? <Spinner /> : null}
          windowSize={9}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          removeClippedSubviews
          contentContainerStyle={styles.content}
          accessibilityLabel={copy.notificationsTitle}
        />
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: space[6] },
  skeletonRow: {
    height: NOTIFICATION_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingHorizontal: spacing.screenMargin,
  },
  skeletonLines: { flex: 1, gap: space[2] },
})
