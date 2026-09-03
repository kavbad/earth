/**
 * The one button (spec §88: calm, physical): primary (ink on white), secondary (subtle fill),
 * quiet (text) and destructive (text in the system red). 44pt targets, no gradients, no pills.
 */
import { colors, radius, space, touchTarget } from '@earth/ui'
import { ActivityIndicator, Pressable, StyleSheet, Text, type ViewStyle } from 'react-native'

import { text } from './text'

export const BUTTON_VARIANTS = ['primary', 'secondary', 'quiet', 'destructive'] as const
export type ButtonVariant = (typeof BUTTON_VARIANTS)[number]

export interface ButtonProps {
  readonly label: string
  readonly onPress: () => void
  readonly variant?: ButtonVariant
  readonly disabled?: boolean
  /** Shows a spinner and disables the control. */
  readonly loading?: boolean
  readonly fullWidth?: boolean
  /** Compact height for rows. */
  readonly compact?: boolean
  readonly accessibilityLabel?: string
  readonly accessibilityHint?: string
  /** `pressed` for toggles (Following, Friends). */
  readonly selected?: boolean
  readonly style?: ViewStyle
}

const BACKGROUND: Record<ButtonVariant, string> = {
  primary: colors.textPrimary,
  secondary: colors.subtleFill,
  quiet: 'transparent',
  destructive: 'transparent',
}

const FOREGROUND: Record<ButtonVariant, string> = {
  primary: colors.background,
  secondary: colors.textPrimary,
  quiet: colors.textPrimary,
  destructive: colors.danger,
}

/** A compact button draws shorter than 44pt; the hit area still reaches the minimum target. */
const COMPACT_HEIGHT = space[10]
const COMPACT_HIT_SLOP = (touchTarget - COMPACT_HEIGHT) / 2

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  fullWidth = false,
  compact = false,
  accessibilityLabel,
  accessibilityHint,
  selected,
  style,
}: ButtonProps) {
  const inactive = disabled || loading
  return (
    <Pressable
      onPress={onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      {...(compact ? { hitSlop: COMPACT_HIT_SLOP } : {})}
      {...(accessibilityHint === undefined ? {} : { accessibilityHint })}
      accessibilityState={{
        disabled: inactive,
        busy: loading,
        ...(selected === undefined ? {} : { selected }),
      }}
      style={({ pressed }) => [
        styles.base,
        { backgroundColor: BACKGROUND[variant] },
        compact && styles.compact,
        fullWidth && styles.fullWidth,
        inactive && styles.inactive,
        pressed && !inactive && styles.pressed,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={FOREGROUND[variant]} />
      ) : (
        <Text
          style={[
            variant === 'quiet' ? text.body : text.bodyMedium,
            { color: FOREGROUND[variant] },
          ]}
          numberOfLines={1}
        >
          {label}
        </Text>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  base: {
    minHeight: touchTarget,
    paddingHorizontal: space[5],
    borderRadius: radius.medium,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  compact: { minHeight: COMPACT_HEIGHT, paddingHorizontal: space[4] },
  fullWidth: { alignSelf: 'stretch' },
  inactive: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
})
