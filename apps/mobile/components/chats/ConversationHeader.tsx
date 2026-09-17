/**
 * SCREEN 10/11 header: back, faces + name (tap → info), a quiet presence line (typing / active),
 * and — only when the group has a room open — the contextual `3 live · Join` line to the room
 * (a small live dot, never a colored border — spec §92).
 */
import type { ConversationDetailDto } from '@earth/domain'
import { borderWidth, colors, copy, radius, space, spacing, touchTarget } from '@earth/ui'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { FaceStack, IconButton, Skeleton, text } from '@/components/ui'
import { chatCopy } from '@/features/chats/copy'
import { type ConversationPresence, presenceLine } from '@/features/chats/state/list'

export interface ConversationHeaderProps {
  readonly conversation: ConversationDetailDto | undefined
  readonly presence: ConversationPresence
  readonly liveCount: number
  readonly onBack: () => void
  readonly onOpenInfo: () => void
  readonly onJoinRoom: () => void
}

const SKELETON_FACE = 32
const SKELETON_LINE = 128

export function ConversationHeader({
  conversation,
  presence,
  liveCount,
  onBack,
  onOpenInfo,
  onJoinRoom,
}: ConversationHeaderProps) {
  const insets = useSafeAreaInsets()
  const subtitle = presenceLine(presence)
  const people = (conversation?.members ?? []).map((member) => ({
    displayName: member.displayName,
    avatarUrl: member.avatarUrl,
  }))
  const activeRoom = conversation?.activeRoom ?? null
  return (
    <View style={[styles.header, { paddingTop: insets.top }]}>
      <View style={styles.row}>
        <IconButton name="back" label={chatCopy.back} onPress={onBack} />
        {conversation === undefined ? (
          <View style={styles.skeleton}>
            <Skeleton width={SKELETON_FACE} height={SKELETON_FACE} round />
            <Skeleton width={SKELETON_LINE} />
          </View>
        ) : (
          <Pressable
            onPress={onOpenInfo}
            accessibilityRole="button"
            accessibilityLabel={`${conversation.title} · ${chatCopy.openInfo}`}
            style={({ pressed }) => [styles.identity, pressed && styles.pressed]}
          >
            <FaceStack
              people={
                people.length > 0
                  ? people
                  : [
                      {
                        displayName: conversation.title,
                        avatarUrl: conversation.avatarUrls[0] ?? null,
                      },
                    ]
              }
              max={conversation.type === 'direct' ? 1 : 3}
              total={conversation.members.length}
              size="small"
              label={conversation.title}
            />
            <View style={styles.titles}>
              <Text style={[text.section, text.primary]} numberOfLines={1}>
                {conversation.title}
              </Text>
              {subtitle.length > 0 ? (
                <Text
                  style={[text.secondary, text.muted]}
                  numberOfLines={1}
                  accessibilityLiveRegion="polite"
                >
                  {subtitle}
                </Text>
              ) : null}
            </View>
          </Pressable>
        )}
      </View>
      {activeRoom !== null && liveCount > 0 ? (
        <Pressable
          onPress={onJoinRoom}
          accessibilityRole="button"
          accessibilityLabel={copy.liveJoinLine(liveCount)}
          style={styles.liveLine}
        >
          <View style={styles.liveDot} />
          <Text style={[text.secondary, text.primary]}>{copy.liveJoinLine(liveCount)}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: colors.background,
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: colors.separator,
    paddingHorizontal: space[2],
  },
  row: {
    minHeight: touchTarget + space[2],
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
  },
  identity: {
    flex: 1,
    minWidth: 0,
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.rowGapLoose,
    paddingVertical: space[1],
    paddingRight: space[2],
    borderRadius: radius.medium,
  },
  pressed: { backgroundColor: colors.subtleFill },
  titles: { flex: 1, minWidth: 0 },
  skeleton: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.rowGapLoose },
  liveLine: {
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[2],
    paddingBottom: space[2],
  },
  liveDot: { width: 8, height: 8, borderRadius: radius.avatar, backgroundColor: colors.live },
})
