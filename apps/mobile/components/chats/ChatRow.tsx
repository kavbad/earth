/**
 * One row of SCREEN 08: faces, conversation name, the last meaningful message or a contextual
 * state ("Maya + 2 live") when the group has a room open, unread state, a compact time. Fixed
 * height so the list can lay rows out without measuring.
 */
import type { ConversationId, ConversationSummaryDto, HumanId } from '@earth/domain'
import { borderWidth, colors, copy, radius, relativeTime, space, spacing } from '@earth/ui'
import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { useActiveRoomNames } from '@/features/chats/hooks/useActiveRoomNames'
import { chatRowLabel, previewLine } from '@/features/chats/state/list'
import { isUnread } from '@/features/chats/state/read'

import { Avatar, FaceStack, text } from '@/components/ui'

export const CHAT_ROW_HEIGHT = 72

export interface ChatRowProps {
  readonly conversation: ConversationSummaryDto
  readonly viewerId: HumanId | null
  readonly onPress: (conversationId: ConversationId) => void
  readonly now?: Date
}

function ChatRowView({ conversation, viewerId, onPress, now }: ChatRowProps) {
  const activeRoom = conversation.activeRoom
  const live = useActiveRoomNames(activeRoom?.roomId ?? null, activeRoom?.participantCount ?? 0)
  const unread = isUnread(conversation)
  const liveLine = activeRoom === null ? '' : copy.chatRowLive(live.names, live.total)
  const subtitle = liveLine.length > 0 ? liveLine : previewLine(conversation, viewerId)
  const time =
    conversation.lastMessageAt === null ? '' : relativeTime(conversation.lastMessageAt, now)
  const people = conversation.avatarUrls.map((avatarUrl, index) => ({
    displayName: index === 0 ? conversation.title : '',
    avatarUrl,
  }))

  return (
    <Pressable
      onPress={() => onPress(conversation.id)}
      accessibilityRole="button"
      accessibilityLabel={chatRowLabel(conversation, subtitle)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.faces}>
        {people.length > 1 ? (
          <FaceStack people={people} max={2} size="medium" label={conversation.title} />
        ) : (
          <Avatar
            name={conversation.title}
            src={people[0]?.avatarUrl ?? null}
            size="medium"
            decorative
            live={activeRoom !== null}
          />
        )}
      </View>
      <View style={styles.body}>
        <View style={styles.line}>
          <Text
            style={[unread ? text.bodyMedium : text.body, text.primary, styles.grow]}
            numberOfLines={1}
          >
            {conversation.title}
          </Text>
          {time.length > 0 ? <Text style={[text.meta, text.muted]}>{time}</Text> : null}
        </View>
        <View style={styles.line}>
          {activeRoom !== null ? <View style={styles.liveDot} /> : null}
          <Text
            style={[
              text.secondary,
              activeRoom !== null || unread ? text.primary : text.muted,
              styles.grow,
            ]}
            numberOfLines={1}
          >
            {subtitle}
          </Text>
          {unread ? <View style={styles.unreadDot} /> : null}
        </View>
      </View>
    </Pressable>
  )
}

export const ChatRow = memo(ChatRowView)

const styles = StyleSheet.create({
  row: {
    height: CHAT_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.rowGapLoose,
    paddingHorizontal: spacing.screenMargin,
    backgroundColor: colors.background,
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: colors.separator,
  },
  pressed: { backgroundColor: colors.subtleFill },
  faces: { flexShrink: 0 },
  body: { flex: 1, minWidth: 0, gap: space[1] / 2 },
  line: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  grow: { flex: 1, minWidth: 0 },
  liveDot: { width: 8, height: 8, borderRadius: radius.avatar, backgroundColor: colors.live },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: radius.avatar,
    backgroundColor: colors.earthAccent,
  },
})
