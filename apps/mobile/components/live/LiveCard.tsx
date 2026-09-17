/**
 * One Live in the Live Home list (SCREEN 13, spec §92): faces, the participant-aware title, a
 * quiet second line and the small Live mark — never a colored border, never autoplay. A fixed
 * row height so the list can jump (`getItemLayout`).
 */
import type { LiveCardDto } from '@earth/domain'
import { colors, space, spacing } from '@earth/ui'
import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { FaceStack } from '@/components/ui/FaceStack'
import { LiveMark } from '@/components/ui/LiveMark'
import { text } from '@/components/ui/text'
import { LIVE_ROW_HEIGHT, cardContextLine, cardFaces } from '@/features/rooms/state/live'

export interface LiveCardProps {
  readonly card: LiveCardDto
  readonly onOpen: (card: LiveCardDto) => void
}

function LiveCardView({ card, onOpen }: LiveCardProps) {
  const line = cardContextLine(card)
  return (
    <Pressable
      onPress={() => onOpen(card)}
      accessibilityRole="button"
      accessibilityLabel={line.length > 0 ? `${card.title}, ${line}` : card.title}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <FaceStack
        people={cardFaces(card)}
        total={card.participantCount}
        size="medium"
        label={card.title}
      />
      <View style={styles.middle}>
        <Text style={[text.bodyMedium, text.primary]} numberOfLines={1}>
          {card.title}
        </Text>
        {line.length > 0 ? (
          <Text style={[text.secondary, text.muted]} numberOfLines={1}>
            {line}
          </Text>
        ) : null}
      </View>
      <LiveMark text={false} />
    </Pressable>
  )
}

export const LiveCard = memo(LiveCardView)

const styles = StyleSheet.create({
  row: {
    height: LIVE_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.rowGapLoose,
    paddingHorizontal: spacing.screenMargin,
    paddingVertical: space[3],
    backgroundColor: colors.background,
  },
  pressed: { backgroundColor: colors.subtleFill },
  middle: { flex: 1, minWidth: 0 },
})
