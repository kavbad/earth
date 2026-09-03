/**
 * SCREEN 02 presence row: "Xavier + Maya live", "Weekend Crew · 3 active", "Sarah nearby" —
 * rendered only with meaningful state (the caller passes nothing otherwise). Live items carry
 * the small live dot and faces; a room opens the room, a group its conversation.
 */
import type { PresenceItemDto } from '@earth/domain'
import { colors, radius, space, touchTarget } from '@earth/ui'
import { useRouter } from 'expo-router'
import { memo } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import { FaceStack, LiveMark, text } from '@/components/ui'
import { feedCopy } from '@/features/feed/copy'
import { presenceHref } from '@/features/feed/state/feed'
import { lightTap } from '@/lib/haptics'

export interface PresenceRowProps {
  readonly items: readonly PresenceItemDto[]
}

function PresenceChipView({ item }: { readonly item: PresenceItemDto }) {
  const router = useRouter()
  const href = presenceHref(item)
  const faces = item.avatarUrls.map((avatarUrl) => ({ displayName: item.label, avatarUrl }))
  const content = (
    <>
      {faces.length > 0 ? <FaceStack people={faces} size="small" label={item.label} /> : null}
      {item.type === 'friends_live' ? <LiveMark text={false} /> : null}
      <Text style={[text.secondary, text.primary]} numberOfLines={1}>
        {item.label}
      </Text>
    </>
  )
  if (href === null) {
    return (
      <View style={styles.chip} accessible accessibilityLabel={item.label}>
        {content}
      </View>
    )
  }
  return (
    <Pressable
      onPress={() => {
        lightTap()
        router.push(href)
      }}
      accessibilityRole="button"
      accessibilityLabel={item.label}
      style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  )
}

const PresenceChip = memo(PresenceChipView)

export function PresenceRow({ items }: PresenceRowProps) {
  if (items.length === 0) return null
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      style={styles.scroll}
      accessibilityLabel={feedCopy.presenceLabel}
    >
      {items.map((item, index) => (
        <PresenceChip
          key={`${item.type}-${item.roomId ?? item.conversationId ?? index}`}
          item={item}
        />
      ))}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  scroll: { marginHorizontal: -space[2] },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[1], paddingHorizontal: space[2] },
  chip: {
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[2],
    borderRadius: radius.medium,
  },
  pressed: { backgroundColor: colors.subtleFill },
})
