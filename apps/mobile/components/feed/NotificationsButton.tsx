/**
 * The Notifications control in Home's header (SCREEN 02 → 23): a 44pt bell drawn with the shared
 * icon conventions (`@earth/ui` has no bell of its own) and a small Earth-accent dot when
 * something is unread — the accent appears sparingly (spec §89). Humans only.
 */
import {
  ICON_LINECAP,
  ICON_LINEJOIN,
  ICON_STROKE_WIDTH,
  ICON_VIEWBOX,
  borderWidth,
  colors,
  copy,
  iconSize,
  radius,
  touchTarget,
} from '@earth/ui'
import { Pressable, StyleSheet, View } from 'react-native'
import Svg, { Path } from 'react-native-svg'

import { feedCopy } from '@/features/feed/copy'

export interface NotificationsButtonProps {
  readonly unreadCount: number
  readonly onPress: () => void
}

const BELL_PATHS = [
  'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9',
  'M10.3 21a1.94 1.94 0 0 0 3.4 0',
] as const
const DOT = 8

export function notificationsButtonLabel(unreadCount: number): string {
  return unreadCount > 0
    ? `${copy.notificationsTitle}, ${feedCopy.unreadCount(unreadCount)}`
    : copy.notificationsTitle
}

export function NotificationsButton({ unreadCount, onPress }: NotificationsButtonProps) {
  const px = iconSize.base
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={notificationsButtonLabel(unreadCount)}
      hitSlop={4}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <View>
        <Svg
          viewBox={ICON_VIEWBOX}
          width={px}
          height={px}
          accessible={false}
          importantForAccessibility="no-hide-descendants"
        >
          {BELL_PATHS.map((d) => (
            <Path
              key={d}
              d={d}
              fill="none"
              stroke={colors.textPrimary}
              strokeWidth={ICON_STROKE_WIDTH}
              strokeLinecap={ICON_LINECAP}
              strokeLinejoin={ICON_LINEJOIN}
            />
          ))}
        </Svg>
        {unreadCount > 0 ? <View style={styles.dot} /> : null}
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: radius.avatar,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },
  dot: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: DOT + borderWidth.indicator * 2,
    height: DOT + borderWidth.indicator * 2,
    borderRadius: radius.avatar,
    backgroundColor: colors.earthAccent,
    borderWidth: borderWidth.indicator,
    borderColor: colors.background,
  },
})
