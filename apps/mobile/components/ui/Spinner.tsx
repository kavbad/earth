import { colors, space } from '@earth/ui'
import { ActivityIndicator, StyleSheet, View } from 'react-native'

export interface SpinnerProps {
  readonly label?: string
  /** Fills the available space and centers the indicator. */
  readonly fill?: boolean
}

export function Spinner({ label, fill = false }: SpinnerProps) {
  return (
    <View
      style={[styles.box, fill && styles.fill]}
      accessible
      accessibilityRole="progressbar"
      {...(label === undefined ? {} : { accessibilityLabel: label })}
      accessibilityState={{ busy: true }}
    >
      <ActivityIndicator color={colors.textSecondary} />
    </View>
  )
}

const styles = StyleSheet.create({
  box: { paddingVertical: space[4], alignItems: 'center', justifyContent: 'center' },
  fill: { flex: 1 },
})
