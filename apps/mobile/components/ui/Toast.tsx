/**
 * One short line above the tab bar, never a stack of alerts: `useToast().show("…")`. Fades in
 * over 180 ms and away after four seconds (spec §95 restraint).
 */
import { colors, motion, radius, space, spacing, zIndex } from '@earth/ui'
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { text } from './text'

export const TOAST_DURATION_MS = 4_000
/** Room above the tab bar (its height plus a step). */
const TAB_BAR_CLEARANCE = space[16] + space[4]

interface ToastItem {
  readonly id: number
  readonly message: string
}

export interface ToastContextValue {
  show(message: string): void
}

const ToastContext = createContext<ToastContextValue>({ show: () => undefined })

export function ToastProvider({ children }: { readonly children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly ToastItem[]>([])
  const counter = useRef(0)
  const show = useCallback((message: string) => {
    counter.current += 1
    const id = counter.current
    setToasts((current) => [...current, { id, message }])
  }, [])
  const onDone = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])
  const value = useMemo(() => ({ show }), [show])
  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDone={onDone} />
    </ToastContext.Provider>
  )
}

function ToastViewport({
  toasts,
  onDone,
}: {
  readonly toasts: readonly ToastItem[]
  readonly onDone: (id: number) => void
}) {
  const insets = useSafeAreaInsets()
  if (toasts.length === 0) return null
  return (
    <View
      pointerEvents="none"
      style={[styles.viewport, { bottom: insets.bottom + TAB_BAR_CLEARANCE }]}
      accessibilityLiveRegion="polite"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDone={onDone} />
      ))}
    </View>
  )
}

const enter = Easing.bezier(...motion.curve.enter)

function ToastCard({ toast, onDone }: { toast: ToastItem; onDone: (id: number) => void }) {
  const opacity = useSharedValue(0)
  useEffect(() => {
    opacity.value = withTiming(1, { duration: motion.duration.fast, easing: enter })
    const timer = setTimeout(() => onDone(toast.id), TOAST_DURATION_MS)
    return () => clearTimeout(timer)
  }, [toast.id, onDone, opacity])
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }))
  return (
    <Animated.View style={[styles.card, style]} accessibilityRole="alert">
      <Text style={[text.secondary, text.inverse]} numberOfLines={2}>
        {toast.message}
      </Text>
    </Animated.View>
  )
}

/** `useToast().show("You're keeping the room open.")` — one short line, never a stack of alerts. */
export function useToast(): ToastContextValue {
  return useContext(ToastContext)
}

const styles = StyleSheet.create({
  viewport: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: spacing.screenMargin,
    zIndex: zIndex.toast,
  },
  card: {
    backgroundColor: colors.textPrimary,
    borderRadius: radius.medium,
    paddingHorizontal: space[4],
    paddingVertical: space[3],
    maxWidth: 480,
  },
})
