/**
 * A subtle placeholder block while cached content is on its way (never a whole-page error):
 * the subtle fill, breathing slowly between two opacities.
 */
import { colors, radius } from '@earth/ui'
import { useEffect } from 'react'
import { type DimensionValue, StyleSheet } from 'react-native'
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'

export interface SkeletonProps {
  readonly width?: DimensionValue
  readonly height?: number
  readonly round?: boolean
}

const BREATH_MS = 1_600

export function Skeleton({ width = '100%', height = 16, round = false }: SkeletonProps) {
  const opacity = useSharedValue(1)
  useEffect(() => {
    opacity.value = withRepeat(
      withTiming(0.55, { duration: BREATH_MS / 2, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    )
  }, [opacity])
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }))
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.block,
        { width, height, borderRadius: round ? radius.avatar : radius.small },
        style,
      ]}
    />
  )
}

const styles = StyleSheet.create({
  block: { backgroundColor: colors.subtleFill },
})
