/**
 * Only where an empty screen has something true to say (spec SCREEN 01–02: no placeholders).
 */
import { space, spacing } from '@earth/ui'
import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { text } from './text'

export interface EmptyStateProps {
  readonly title: string
  readonly body?: string
  readonly action?: ReactNode
}

export function EmptyState({ title, body, action }: EmptyStateProps) {
  return (
    <View style={styles.container} accessible accessibilityRole="summary">
      <Text style={[text.section, text.primary]}>{title}</Text>
      {body ? <Text style={[text.secondary, text.muted]}>{body}</Text> : null}
      {action !== undefined ? <View style={styles.action}>{action}</View> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.screenMargin,
    paddingVertical: space[8],
    alignItems: 'flex-start',
    gap: space[2],
  },
  action: { marginTop: space[2] },
})
