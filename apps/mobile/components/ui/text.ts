/**
 * The type scale as React Native text styles, from the @earth/ui tokens (spec §90): each style
 * carries its size, line height, weight, tracking and — because RN picks a face by file, not by
 * weight — the bundled font file for its family and weight (`fontFor`). The files are loaded once
 * in `app/_layout.tsx` from `@expo-google-fonts/*` under exactly these names. Colors are applied
 * at the call site from `colors` so a style never hard-codes a hex.
 */
import {
  type FontFamilyName,
  type TypeStyle,
  type TypographyName,
  colors,
  typography,
} from '@earth/ui'
import { StyleSheet, type TextStyle } from 'react-native'

export type Weight = '400' | '500' | '600'

/** `useFonts` keys in `app/_layout.tsx` — a face and weight name one file on both platforms. */
const FONT_FOR: Record<FontFamilyName, Record<Weight, string>> = {
  serif: {
    '400': 'Newsreader_400Regular',
    '500': 'Newsreader_500Medium',
    '600': 'Newsreader_600SemiBold',
  },
  sans: {
    '400': 'InstrumentSans_400Regular',
    '500': 'InstrumentSans_500Medium',
    '600': 'InstrumentSans_600SemiBold',
  },
}

function weightOf(value: number): Weight {
  return String(value) as Weight
}

/** The font file for a face at a weight; use it wherever a style sets `fontWeight` by hand. */
export function fontFor(family: FontFamilyName, weight: Weight | number): string {
  return FONT_FOR[family][typeof weight === 'number' ? weightOf(weight) : weight]
}

function textStyle(name: TypographyName): TextStyle {
  const style: TypeStyle = typography[name]
  const base: TextStyle = {
    fontFamily: fontFor(style.family, style.weight),
    fontSize: style.size,
    lineHeight: style.lineHeight,
    fontWeight: weightOf(style.weight),
  }
  // RN tracking is in points, the token is in em.
  return style.letterSpacing === undefined
    ? base
    : { ...base, letterSpacing: style.letterSpacing * style.size }
}

export const text = StyleSheet.create({
  display: textStyle('display'),
  title: textStyle('title'),
  section: textStyle('section'),
  body: textStyle('body'),
  secondary: textStyle('secondary'),
  meta: textStyle('meta'),
  bodyMedium: { ...textStyle('body'), fontWeight: '500', fontFamily: fontFor('sans', '500') },
  primary: { color: colors.textPrimary },
  muted: { color: colors.textSecondary },
  tertiary: { color: colors.textTertiary },
  inverse: { color: colors.background },
  accent: { color: colors.earthAccent },
  danger: { color: colors.danger },
  live: { color: colors.live },
})
