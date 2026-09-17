/**
 * Overlapping faces — the way Live and group previews say who is there (spec §92).
 */
import { type AvatarSizeName, avatarSize, borderWidth, colors, radius, space } from '@earth/ui'
import { StyleSheet, Text, View } from 'react-native'

import { Avatar } from './Avatar'
import { text } from './text'

export interface FaceStackPerson {
  readonly displayName: string
  readonly avatarUrl: string | null
}

export interface FaceStackProps {
  readonly people: readonly FaceStackPerson[]
  /** Faces shown before the rest collapses into `+N`. */
  readonly max?: number
  /** Total number of people when `people` is only a sample. */
  readonly total?: number
  readonly size?: AvatarSizeName
  /** Accessible summary for the whole stack (`Maya, Xavier + 5 others`). */
  readonly label: string
}

export function FaceStack({ people, max = 3, total, size = 'small', label }: FaceStackProps) {
  const shown = people.slice(0, max)
  const count = Math.max(total ?? people.length, shown.length)
  const rest = count - shown.length
  const px = avatarSize[size]
  const overlap = Math.round(px / 4)
  return (
    <View style={styles.row} accessible accessibilityRole="image" accessibilityLabel={label}>
      {shown.map((person, index) => (
        <View
          key={`${person.displayName}-${index}`}
          style={[
            styles.ring,
            { marginLeft: index === 0 ? 0 : -overlap, zIndex: shown.length - index },
          ]}
        >
          <Avatar name={person.displayName} src={person.avatarUrl} size={size} decorative />
        </View>
      ))}
      {rest > 0 ? <Text style={[text.meta, text.muted, styles.rest]}>+{rest}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  ring: {
    borderRadius: radius.avatar,
    borderWidth: borderWidth.indicator,
    borderColor: colors.background,
  },
  rest: { marginLeft: space[1] },
})
