/**
 * Spec §92: a small red dot and the meta word "Live" — never a colored border.
 */
import { colors, copy, radius, space } from '@earth/ui'
import { StyleSheet, Text, View } from 'react-native'

import { text } from './text'

export interface LiveMarkProps {
  /** Show the word next to the dot; the dot alone still carries the accessible name. */
  readonly text?: boolean
}

const DOT = 8

export function LiveMark({ text: showText = true }: LiveMarkProps) {
  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole="image"
      accessibilityLabel={copy.tabs.live}
    >
      <View style={styles.dot} />
      {showText ? <Text style={[text.meta, text.live]}>{copy.tabs.live}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  dot: { width: DOT, height: DOT, borderRadius: radius.avatar, backgroundColor: colors.live },
})
