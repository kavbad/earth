/**
 * The type scale as React Native text styles (spec §90), built from `@earth/ui` tokens only:
 * system font, exact sizes and weights, 4pt line heights. Colors are applied at the call site
 * from `colors` so a style never hard-codes a hex.
 */
import { type TypographyName, colors, typography } from '@earth/ui'
import { StyleSheet, type TextStyle } from 'react-native'

type Weight = '400' | '500' | '600'

function weightOf(value: number): Weight {
  return String(value) as Weight
}

function textStyle(name: TypographyName): TextStyle {
  const style = typography[name]
  return { fontSize: style.size, lineHeight: style.lineHeight, fontWeight: weightOf(style.weight) }
}

export const text = StyleSheet.create({
  display: textStyle('display'),
  title: textStyle('title'),
  section: textStyle('section'),
  body: textStyle('body'),
  secondary: textStyle('secondary'),
  meta: textStyle('meta'),
  /** Body weight bumped to medium (selected labels, unread rows). */
  bodyMedium: { ...textStyle('body'), fontWeight: weightOf(500) },
  primary: { color: colors.textPrimary },
  muted: { color: colors.textSecondary },
  inverse: { color: colors.background },
  accent: { color: colors.earthAccent },
  danger: { color: colors.danger },
  live: { color: colors.live },
})
