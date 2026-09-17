/**
 * Who is sharing (SCREEN 20 list / Settings → Privacy → Location): the Human's own active
 * shares with "Stop sharing", and the friends whose shares reach them.
 */
import { copy, space } from '@earth/ui'
import { StyleSheet, Text, View } from 'react-native'

import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { ListRow } from '@/components/ui/ListRow'
import { text } from '@/components/ui/text'
import { locationCopy } from '@/features/earth/copy'
import { formatClock } from '@/features/earth/state/duration'
import type { FriendMarker } from '@/features/earth/state/markers'
import type { MyShare } from '@/features/earth/state/myShares'

export interface VisibleSharesListProps {
  readonly mine: readonly MyShare[]
  readonly friends: readonly FriendMarker[]
  readonly busyShareId?: string | null
  readonly onRevoke: (share: MyShare) => void
  readonly onFocusFriend?: ((friend: FriendMarker) => void) | undefined
}

function untilLine(precision: keyof typeof locationCopy.precision, expiresAt: string): string {
  return `${locationCopy.precision[precision]} · ${locationCopy.until(formatClock(new Date(expiresAt)))}`
}

export function VisibleSharesList({
  mine,
  friends,
  busyShareId = null,
  onRevoke,
  onFocusFriend,
}: VisibleSharesListProps) {
  return (
    <View style={styles.root}>
      <View style={styles.section} accessibilityLabel={locationCopy.yourShares}>
        <Text style={[text.meta, text.muted]} accessibilityRole="header">
          {locationCopy.yourShares}
        </Text>
        {mine.length === 0 ? (
          <Text style={[text.secondary, text.muted]}>{locationCopy.nothingShared}</Text>
        ) : (
          mine.map((share, index) => (
            <ListRow
              key={share.id}
              flush
              title={copy.shareWith(share.audienceName)}
              subtitle={untilLine(share.precision, share.expiresAt)}
              separator={index < mine.length - 1}
              trailing={
                <Button
                  variant="quiet"
                  compact
                  loading={busyShareId === share.id}
                  label={locationCopy.stopSharing}
                  onPress={() => onRevoke(share)}
                />
              }
            />
          ))
        )}
      </View>
      <View style={styles.section} accessibilityLabel={locationCopy.friendsSharing}>
        <Text style={[text.meta, text.muted]} accessibilityRole="header">
          {locationCopy.friendsSharing}
        </Text>
        {friends.length === 0 ? (
          <Text style={[text.secondary, text.muted]}>{locationCopy.noFriendsSharing}</Text>
        ) : (
          friends.map((friend, index) => (
            <ListRow
              key={friend.id}
              flush
              leading={
                <Avatar name={friend.displayName} src={friend.avatarUrl} size="small" decorative />
              }
              title={friend.displayName}
              subtitle={untilLine(friend.precision, friend.expiresAt)}
              separator={index < friends.length - 1}
              {...(onFocusFriend === undefined
                ? {}
                : {
                    onPress: () => onFocusFriend(friend),
                    accessibilityLabel: locationCopy.showOnMap(friend.displayName),
                  })}
            />
          ))
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { gap: space[4] },
  section: { gap: space[1] },
})
