/**
 * The signature motion of spec §95: a map point expands into the Live. A white surface grows
 * from the tapped marker to the whole viewport in 240 ms (scale + crossfade), then the room
 * route takes over (the root stack fades `/rooms/[id]` in). People who asked for reduced motion
 * go straight to the room.
 */
import { colors, motion, radius, zIndex } from '@earth/ui'
import { useRouter } from 'expo-router'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, StyleSheet, useWindowDimensions } from 'react-native'
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'

import { roomRoute } from '@/features/earth/routes'

import type { ScreenPoint } from './types'

export const EXPAND_DURATION_MS = motion.duration.base
/** Keeps the overlay while the next route paints; cleared afterwards. */
const OVERLAY_LINGER_MS = motion.duration.slow
const SEED_PT = 44
const standard = Easing.bezier(...motion.curve.standard)

interface ExpandRequest {
  readonly roomId: string
  readonly point: ScreenPoint
}

export interface LiveExpand {
  /** Starts the motion from `point` (or goes straight to the room without one). */
  start(roomId: string, point: ScreenPoint | null): void
  /** Render this above the map. */
  readonly overlay: ReactNode
}

export function useLiveExpand(): LiveExpand {
  const router = useRouter()
  const [request, setRequest] = useState<ExpandRequest | null>(null)
  const reduceMotion = useRef(false)

  useEffect(() => {
    let active = true
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (active) reduceMotion.current = enabled
      })
      .catch(() => undefined)
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (enabled) => {
      reduceMotion.current = enabled
    })
    return () => {
      active = false
      subscription.remove()
    }
  }, [])

  const start = useCallback(
    (roomId: string, point: ScreenPoint | null) => {
      if (point === null || reduceMotion.current) {
        router.push(roomRoute(roomId))
        return
      }
      setRequest({ roomId, point })
    },
    [router],
  )

  const onArrived = useCallback(
    (roomId: string) => {
      router.push(roomRoute(roomId))
      setTimeout(() => setRequest(null), OVERLAY_LINGER_MS)
    },
    [router],
  )

  const overlay =
    request === null ? null : (
      <ExpandOverlay key={request.roomId} request={request} onArrived={onArrived} />
    )

  return { start, overlay }
}

function ExpandOverlay({
  request,
  onArrived,
}: {
  readonly request: ExpandRequest
  readonly onArrived: (roomId: string) => void
}) {
  const { width, height } = useWindowDimensions()
  const progress = useSharedValue(0)
  const { roomId } = request
  // Scale that covers the viewport from the seed wherever it sits.
  const farX = Math.max(request.point.x, width - request.point.x)
  const farY = Math.max(request.point.y, height - request.point.y)
  const targetScale = (Math.hypot(farX, farY) * 2) / SEED_PT + 0.5

  useEffect(() => {
    progress.value = withTiming(
      1,
      { duration: EXPAND_DURATION_MS, easing: standard },
      (finished) => {
        if (finished === true) runOnJS(onArrived)(roomId)
      },
    )
  }, [progress, onArrived, roomId])

  const style = useAnimatedStyle(() => ({
    opacity: 0.4 + progress.value * 0.6,
    transform: [{ scale: 1 + (targetScale - 1) * progress.value }],
  }))

  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.seed,
        { left: request.point.x - SEED_PT / 2, top: request.point.y - SEED_PT / 2 },
        style,
      ]}
    />
  )
}

const styles = StyleSheet.create({
  seed: {
    position: 'absolute',
    width: SEED_PT,
    height: SEED_PT,
    borderRadius: radius.medium,
    backgroundColor: colors.background,
    zIndex: zIndex.modal,
  },
})
