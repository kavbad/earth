/**
 * SCREEN 23 row: actor faces, the exact spec copy (title, body), time. Unread rows read heavier
 * with a small accent dot; a friend request can be accepted in place; Lives carry the small Live
 * mark. Tapping goes where the notification points (room, conversation, profile). Rows share one
 * fixed height so the list can lay them out without measuring (`getItemLayout`).
 */
import type { HumanId } from '@earth/domain'
import {
  avatarSize,
  borderWidth,
  colors,
  copy,
  radius,
  relativeTime,
  space,
  spacing,
} from '@earth/ui'
import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { Avatar, Button, FaceStack, LiveMark, text } from '@/components/ui'
import { feedCopy } from '@/features/feed/copy'
import {
  NOTIFICATION_ROW_HEIGHT,
  type NotificationRow as Row,
  destinationHref,
} from '@/features/feed/state/notifications'

export interface NotificationRowProps {
  readonly row: Row
  readonly onAccept: (row: Row, actorHumanId: HumanId) => Promise<boolean>
  /** Tapping a row: mark it read, then follow its destination when it has one. */
  readonly onOpen: (row: Row) => void
}

const DOT = 8

function NotificationRowView({ row, onAccept, onOpen }: NotificationRowProps) {
  const actorHumanId = row.actorHumanId
  const href = destinationHref(row.destination)
  const first = row.faces[0]
  const label = copy.notificationLine({ title: row.title, body: row.body })

  const faces =
    row.faces.length > 1 ? (
      <FaceStack
        people={row.faces}
        size="medium"
        label={row.faces.map((face) => face.displayName).join(', ')}
      />
    ) : first !== undefined ? (
      <Avatar name={first.displayName} src={first.avatarUrl} decorative live={row.live} />
    ) : (
      <View style={styles.placeholderFace} />
    )

  return (
    <View style={[styles.row, row.unread && styles.unread]}>
      <Pressable
        onPress={() => onOpen(row)}
        disabled={href === null && !row.unread}
        accessibilityRole="button"
        accessibilityLabel={row.unread ? `${label} · ${feedCopy.unread}` : label}
        style={({ pressed }) => [styles.main, pressed && href !== null && styles.pressed]}
      >
        <View style={styles.faces}>{faces}</View>
        <View style={styles.middle}>
          <Text style={[row.unread ? text.bodyMedium : text.body, text.primary]} numberOfLines={1}>
            {row.title}
          </Text>
          <Text style={[text.secondary, text.muted]} numberOfLines={1}>
            {row.body !== '' ? row.body : ' '}
          </Text>
          <View style={styles.metaRow}>
            {row.live ? <LiveMark /> : null}
            <Text style={[text.meta, text.muted]}>{relativeTime(row.createdAt)}</Text>
          </View>
        </View>
        {row.unread ? <View style={styles.dot} /> : null}
      </Pressable>
      {row.acceptable && actorHumanId !== null ? (
        <View style={styles.accept}>
          <Button
            compact
            label={feedCopy.accept}
            accessibilityLabel={`${feedCopy.accept}: ${row.title}`}
            onPress={() => void onAccept(row, actorHumanId)}
          />
        </View>
      ) : null}
    </View>
  )
}

export const NotificationRow = memo(NotificationRowView)

const styles = StyleSheet.create({
  row: {
    height: NOTIFICATION_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background,
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: colors.separator,
  },
  unread: { backgroundColor: colors.subtleFill },
  main: {
    flex: 1,
    minWidth: 0,
    height: '100%',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space[3],
    paddingHorizontal: spacing.screenMargin,
    paddingVertical: space[3],
  },
  pressed: { opacity: 0.7 },
  faces: { width: avatarSize.medium, alignItems: 'center', paddingTop: space[1] },
  placeholderFace: {
    width: avatarSize.medium,
    height: avatarSize.medium,
    borderRadius: radius.avatar,
    backgroundColor: colors.subtleFill,
  },
  middle: { flex: 1, minWidth: 0 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  dot: {
    width: DOT,
    height: DOT,
    borderRadius: radius.avatar,
    backgroundColor: colors.earthAccent,
    marginTop: space[2],
  },
  accept: { paddingRight: spacing.screenMargin },
})
