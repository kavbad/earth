/**
 * A compact row (sheets, settings, results): 8–12 pt gaps, hairline separators from the list,
 * 44pt minimum. Pressable when `onPress` is given.
 */
import { borderWidth, colors, space, spacing, touchTarget } from '@earth/ui'
import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { text } from './text'

export interface ListRowProps {
  readonly leading?: ReactNode
  readonly title: string
  readonly subtitle?: string | undefined
  readonly trailing?: ReactNode
  readonly onPress?: () => void
  readonly disabled?: boolean
  readonly accessibilityLabel?: string
  readonly accessibilityRole?: 'button' | 'radio' | 'link'
  readonly selected?: boolean
  readonly separator?: boolean
  /** The system red for destructive rows (Block, Delete). */
  readonly destructive?: boolean
  /** Sheets run rows flush with the sheet's own margin. */
  readonly flush?: boolean
}

export function ListRow({
  leading,
  title,
  subtitle,
  trailing,
  onPress,
  disabled = false,
  accessibilityLabel,
  accessibilityRole = 'button',
  selected,
  separator = true,
  destructive = false,
  flush = false,
}: ListRowProps) {
  const body = (
    <>
      {leading !== undefined ? <View style={styles.leading}>{leading}</View> : null}
      <View style={styles.middle}>
        <Text style={[text.body, destructive ? text.danger : text.primary]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle !== undefined && subtitle.length > 0 ? (
          <Text style={[text.secondary, text.muted]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing !== undefined ? <View style={styles.trailing}>{trailing}</View> : null}
    </>
  )
  const rowStyle = [styles.row, flush && styles.flush, separator && styles.separator]
  if (onPress === undefined) {
    return <View style={rowStyle}>{body}</View>
  }
  const state =
    selected === undefined
      ? { disabled }
      : accessibilityRole === 'radio'
        ? { disabled, checked: selected }
        : { disabled, selected }
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}, ${subtitle}` : title)}
      accessibilityState={state}
      style={({ pressed }) => [rowStyle, pressed && styles.pressed, disabled && styles.disabled]}
    >
      {body}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.rowGapLoose,
    paddingHorizontal: spacing.screenMargin,
    paddingVertical: space[2],
    backgroundColor: colors.background,
  },
  flush: { paddingHorizontal: 0 },
  separator: { borderBottomWidth: borderWidth.hairline, borderBottomColor: colors.separator },
  pressed: { backgroundColor: colors.subtleFill },
  disabled: { opacity: 0.4 },
  leading: { flexShrink: 0 },
  middle: { flex: 1, minWidth: 0 },
  trailing: { flexShrink: 0, alignItems: 'flex-end' },
})
