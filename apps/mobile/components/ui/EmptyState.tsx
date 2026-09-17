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
      <Text style={[text.title, text.primary, styles.title]}>{title}</Text>
      {body ? <Text style={[text.body, text.muted, styles.body]}>{body}</Text> : null}
      {action !== undefined ? <View style={styles.action}>{action}</View> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.screenMargin,
    paddingVertical: space[10],
    alignItems: 'flex-start',
    gap: space[3],
  },
  title: { maxWidth: 360 },
  body: { maxWidth: 440 },
  action: { marginTop: space[3] },
})
