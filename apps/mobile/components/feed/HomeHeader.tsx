/**
 * Home's header (SCREEN 01–05): the `earth` wordmark, Search and Notifications at the trailing
 * edge, the radius row under it, the Neighborhood / City subtitle or the city switch (SCREEN
 * 03/04), and the presence row only with meaningful state (SCREEN 02). White, hairline below —
 * the same composition as the web client's header.
 */
import { APP_NAME, borderWidth, colors, space, spacing, touchTarget } from '@earth/ui'
import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { text } from '@/components/ui'

export interface HomeHeaderProps {
  /** Search, Notifications — a row of 44pt controls. */
  readonly trailing?: ReactNode
  /** "North Beach", the current City (string), or the city switch (a node). */
  readonly subtitle?: string | ReactNode
  /** The radius control. */
  readonly children?: ReactNode
  /** The presence row: pass only with meaningful state; nothing renders otherwise. */
  readonly presence?: ReactNode
}

export function HomeHeader({ trailing, subtitle, children, presence }: HomeHeaderProps) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.header, { paddingTop: insets.top + space[2] }]}>
      <View style={styles.row}>
        <View style={styles.titles}>
          <Text style={[text.title, text.primary, styles.wordmark]} accessibilityRole="header">
            {APP_NAME}
          </Text>
          {typeof subtitle === 'string' ? (
            <Text style={[text.secondary, text.muted]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : (
            (subtitle ?? null)
          )}
        </View>
        {trailing !== undefined ? <View style={styles.trailing}>{trailing}</View> : null}
      </View>
      {children !== undefined ? <View>{children}</View> : null}
      {presence !== undefined && presence !== null && presence !== false ? (
        <View style={styles.presence}>{presence}</View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: colors.background,
    paddingHorizontal: spacing.screenMargin,
    paddingBottom: space[2],
    gap: space[2],
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: colors.separator,
  },
  row: { minHeight: touchTarget, flexDirection: 'row', alignItems: 'center', gap: space[3] },
  titles: { flex: 1, minWidth: 0 },
  wordmark: { letterSpacing: -0.5 },
  trailing: { flexDirection: 'row', alignItems: 'center', marginRight: -space[2] },
  presence: { marginTop: space[1] },
})
