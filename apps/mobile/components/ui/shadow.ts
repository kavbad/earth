/**
 * The one shadow token (`shadow.sheet` in @earth/ui) as React Native draws it: iOS from the
 * offset, blur and opacity; Android from an elevation of the same order.
 */
import { colors, shadow } from '@earth/ui'
import type { ViewStyle } from 'react-native'

export const sheetShadow: ViewStyle = {
  shadowColor: colors.textPrimary,
  shadowOpacity: shadow.sheet.opacity,
  shadowRadius: shadow.sheet.blur / 2,
  shadowOffset: { width: 0, height: shadow.sheet.y },
  elevation: shadow.sheet.y,
}
