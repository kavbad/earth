/**
 * The header of a screen: safe-area top, an optional leading control (back), the title, an
 * optional trailing control, and children under it (a radius row, a search field). Hairline
 * below.
 */
import { borderWidth, colors, space, spacing, touchTarget } from '@earth/ui'
import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { text } from './text'

export interface ScreenHeaderProps {
  readonly title: string
  readonly leading?: ReactNode
  readonly trailing?: ReactNode
  readonly children?: ReactNode
  /** Large title (tab roots) or compact (pushed screens). */
  readonly large?: boolean
  /** No hairline (when the content below draws its own edge). */
  readonly flat?: boolean
}

export function ScreenHeader({
  title,
  leading,
  trailing,
  children,
  large = false,
  flat = false,
}: ScreenHeaderProps) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.header, flat && styles.flat, { paddingTop: insets.top }]}>
      <View style={styles.row}>
        {leading !== undefined ? <View style={styles.side}>{leading}</View> : null}
        <Text
          style={[
            large ? text.title : text.section,
            text.primary,
            styles.title,
            leading === undefined && styles.titleFlush,
          ]}
          numberOfLines={1}
          accessibilityRole="header"
        >
          {title}
        </Text>
        {trailing !== undefined ? (
          <View style={styles.side}>{trailing}</View>
        ) : (
          <View style={leading === undefined ? null : styles.side} />
        )}
      </View>
      {children !== undefined ? <View style={styles.children}>{children}</View> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: colors.background,
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: colors.separator,
    paddingHorizontal: spacing.screenMargin,
  },
  flat: { borderBottomWidth: 0 },
  row: {
    minHeight: touchTarget + space[2],
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
  },
  side: { width: touchTarget, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, textAlign: 'center' },
  titleFlush: { textAlign: 'left' },
  children: { paddingBottom: space[3] },
})
