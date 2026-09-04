/**
 * Minimal chrome (SCREEN 14 top): the context — "Weekend Crew" or "Xavier + Kavon" — then one
 * meta line: the Live dot · the audience · viewers.
 */
import type { RoomVisibility } from '@earth/domain'
import { copy, space, spacing } from '@earth/ui'
import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { LiveMark } from '@/components/ui/LiveMark'
import { text } from '@/components/ui/text'
import { roomCopy } from '@/features/rooms/copy'

export interface RoomHeaderProps {
  readonly title: string
  readonly visibility: RoomVisibility
  readonly pendingVisibility: RoomVisibility | null
  readonly watchingCount: number
  readonly trailing?: ReactNode
}

export function RoomHeader({
  title,
  visibility,
  pendingVisibility,
  watchingCount,
  trailing,
}: RoomHeaderProps) {
  const insets = useSafeAreaInsets()
  const audience =
    pendingVisibility === null
      ? copy.visibility[visibility]
      : `${copy.visibility[visibility]} → ${copy.visibility[pendingVisibility]}`
  const meta = [audience, watchingCount > 0 ? roomCopy.watching(watchingCount) : null]
    .filter((part): part is string => part !== null)
    .join(' · ')
  return (
    <View style={[styles.header, { paddingTop: insets.top + space[2] }]}>
      <View style={styles.titles}>
        <Text style={[text.section, text.primary]} numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
        <View style={styles.metaRow}>
          <LiveMark />
          <Text style={[text.meta, text.muted]} numberOfLines={1}>
            · {meta}
          </Text>
        </View>
      </View>
      {trailing !== undefined ? <View style={styles.trailing}>{trailing}</View> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingHorizontal: spacing.screenMargin,
    paddingBottom: space[2],
  },
  titles: { flex: 1, minWidth: 0 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  trailing: { flexShrink: 0, marginRight: -space[2] },
})
