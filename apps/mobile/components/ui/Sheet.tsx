/**
 * A bottom sheet: a transparent modal with a dimmed backdrop and a white panel that slides up in
 * 240 ms on the enter curve and leaves in 180 ms on the exit curve (spec §95). Tapping the
 * backdrop, the close control or the hardware back closes it.
 */
import { colors, motion, radius, space, spacing, touchTarget } from '@earth/ui'
import { type ReactNode, useEffect, useState } from 'react'
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { shellCopy } from '@/lib/copy'

import { Icon } from './Icon'
import { text } from './text'

export interface SheetProps {
  readonly open: boolean
  readonly onClose: () => void
  /** Rendered as the sheet's heading and accessible name. */
  readonly title?: string
  readonly children: ReactNode
  /** Show the close control in the corner (sheets with explicit actions usually don't need it). */
  readonly closeButton?: boolean
  /** The panel hosts a text field: keep it above the keyboard. */
  readonly avoidKeyboard?: boolean
  /** Long content scrolls inside the panel. */
  readonly scroll?: boolean
}

const PANEL_TRAVEL = 480
const BACKDROP_OPACITY = 0.4
const enter = Easing.bezier(...motion.curve.enter)
const exit = Easing.bezier(...motion.curve.exit)

export function Sheet({
  open,
  onClose,
  title,
  children,
  closeButton = false,
  avoidKeyboard = false,
  scroll = false,
}: SheetProps) {
  const insets = useSafeAreaInsets()
  const [mounted, setMounted] = useState(open)
  const progress = useSharedValue(0)
  // Opening mounts at once (derived during render); closing unmounts after the exit motion.
  if (open && !mounted) setMounted(true)

  useEffect(() => {
    if (open) {
      progress.value = withTiming(1, { duration: motion.duration.base, easing: enter })
      return
    }
    progress.value = withTiming(0, { duration: motion.duration.fast, easing: exit })
    const timer = setTimeout(() => setMounted(false), motion.duration.fast)
    return () => clearTimeout(timer)
  }, [open, progress])

  const backdropStyle = useAnimatedStyle(() => ({ opacity: progress.value * BACKDROP_OPACITY }))
  const panelStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (1 - progress.value) * PANEL_TRAVEL }],
  }))

  if (!mounted) return null
  const content = scroll ? (
    <ScrollView keyboardShouldPersistTaps="handled" bounces={false}>
      {children}
    </ScrollView>
  ) : (
    children
  )
  const panel = (
    <Animated.View
      style={[styles.panel, { paddingBottom: insets.bottom + space[4] }, panelStyle]}
      accessibilityViewIsModal
      {...(title === undefined ? {} : { accessibilityLabel: title })}
    >
      {title !== undefined ? (
        <Text style={[text.section, text.primary, styles.title]} accessibilityRole="header">
          {title}
        </Text>
      ) : null}
      {closeButton ? (
        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={shellCopy.close}
          style={styles.close}
          hitSlop={space[2]}
        >
          <Icon name="close" color={colors.textSecondary} />
        </Pressable>
      ) : null}
      {content}
    </Animated.View>
  )
  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
      accessibilityViewIsModal
    >
      <View style={styles.root}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable
            style={styles.backdropPress}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={shellCopy.close}
          />
        </Animated.View>
        {avoidKeyboard ? (
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.avoid}
          >
            {panel}
          </KeyboardAvoidingView>
        ) : (
          panel
        )}
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: colors.textPrimary,
  },
  backdropPress: { flex: 1 },
  avoid: { justifyContent: 'flex-end' },
  panel: {
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.medium,
    borderTopRightRadius: radius.medium,
    paddingHorizontal: spacing.screenMargin,
    paddingTop: space[4],
    maxHeight: '85%',
  },
  title: { marginBottom: space[3], paddingRight: touchTarget },
  close: {
    position: 'absolute',
    top: space[2],
    right: space[2],
    width: touchTarget,
    height: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
