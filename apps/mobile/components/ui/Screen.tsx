/**
 * The frame of a screen: white, the safe-area edges a screen asks for (headers cover the top and
 * the tab bar the bottom by default, so none are padded unless asked), and the keyboard kept
 * clear of the content when a screen hosts a text field. Never a themed or dark surface
 * (spec §88–§89).
 */
import { colors } from '@earth/ui'
import type { ReactNode } from 'react'
import { KeyboardAvoidingView, Platform, StyleSheet, View, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

export type ScreenEdge = 'top' | 'bottom'

export interface ScreenProps {
  readonly children: ReactNode
  /** Safe-area edges to pad (a screen without a header asks for `top`). */
  readonly edges?: readonly ScreenEdge[]
  /** The screen hosts a text field: keep it above the keyboard. */
  readonly avoidKeyboard?: boolean
  readonly style?: ViewStyle
  readonly accessibilityLabel?: string
}

export function Screen({
  children,
  edges = [],
  avoidKeyboard = false,
  style,
  accessibilityLabel,
}: ScreenProps) {
  const insets = useSafeAreaInsets()
  const padding = {
    paddingTop: edges.includes('top') ? insets.top : 0,
    paddingBottom: edges.includes('bottom') ? insets.bottom : 0,
  }
  const body = (
    <View
      style={[styles.root, padding, style]}
      {...(accessibilityLabel === undefined ? {} : { accessibilityLabel })}
    >
      {children}
    </View>
  )
  if (!avoidKeyboard) return body
  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      {body}
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
})
