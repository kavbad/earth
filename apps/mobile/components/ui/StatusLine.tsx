/**
 * Quiet one-line status: "Waiting for connection" (spec §107), "Couldn't refresh" with a retry
 * (spec §110), or a transient note. Never a giant error.
 */
import { colors, space, spacing, touchTarget } from '@earth/ui'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { text } from './text'

export interface StatusLineProps {
  readonly message: string
  readonly actionLabel?: string
  readonly onAction?: () => void
  /** Centered on the subtle fill (banners) or left-aligned inline. */
  readonly banner?: boolean
  /** The system red for a line that reports a failure of the person's own action. */
  readonly danger?: boolean
}

export function StatusLine({
  message,
  actionLabel,
  onAction,
  banner = false,
  danger = false,
}: StatusLineProps) {
  return (
    <View
      style={[styles.line, banner && styles.banner]}
      accessible={actionLabel === undefined}
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
    >
      <Text
        style={[
          banner ? text.meta : text.secondary,
          danger ? text.danger : text.muted,
          styles.message,
          banner && styles.center,
        ]}
        numberOfLines={2}
      >
        {message}
      </Text>
      {actionLabel !== undefined && onAction !== undefined ? (
        <Pressable
          onPress={onAction}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          hitSlop={space[2]}
          style={styles.action}
        >
          <Text style={[text.secondary, text.primary]}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    paddingHorizontal: spacing.screenMargin,
    paddingVertical: space[2],
  },
  banner: {
    backgroundColor: colors.subtleFill,
    justifyContent: 'center',
    paddingVertical: space[2],
  },
  message: { flexShrink: 1 },
  center: { textAlign: 'center' },
  action: { minHeight: touchTarget - space[3], justifyContent: 'center' },
})
