/**
 * A 44pt icon control with an accessible name.
 */
import { type IconName, colors, radius, touchTarget } from '@earth/ui'
import { Pressable, StyleSheet } from 'react-native'

import { Icon } from './Icon'

export interface IconButtonProps {
  readonly name: IconName
  readonly label: string
  readonly onPress: () => void
  readonly disabled?: boolean
  readonly busy?: boolean
  /** Ink on white by default; `filled` inverts. */
  readonly filled?: boolean
  readonly color?: string
}

export function IconButton({
  name,
  label,
  onPress,
  disabled = false,
  busy = false,
  filled = false,
  color,
}: IconButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy }}
      hitSlop={4}
      style={({ pressed }) => [
        styles.button,
        filled && styles.filled,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Icon name={name} color={color ?? (filled ? colors.background : colors.textPrimary)} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: radius.avatar,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filled: { backgroundColor: colors.textPrimary },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
})
