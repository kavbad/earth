/**
 * A face: the photo through `expo-image` (memory + disk cache) or initials on the subtle fill,
 * fully round, with the small Live dot when the person is in a room (spec §92 — never a border).
 */
import {
  type AvatarSizeName,
  avatarSize,
  borderWidth,
  colors,
  initials,
  motion,
  radius,
} from '@earth/ui'
import { Image } from 'expo-image'
import { StyleSheet, Text, type TextStyle, View } from 'react-native'

import { text } from './text'

export interface AvatarProps {
  readonly name: string
  readonly src?: string | null
  readonly size?: AvatarSizeName
  /** Marks the person as currently Live with the small red dot. */
  readonly live?: boolean
  /** When the name is already visible next to the avatar, hide it from assistive tech. */
  readonly decorative?: boolean
}

const FONT: Record<AvatarSizeName, TextStyle> = {
  small: text.meta,
  medium: { ...text.secondary, fontWeight: '500' },
  large: text.section,
  profile: text.title,
}

export function Avatar({
  name,
  src,
  size = 'medium',
  live = false,
  decorative = false,
}: AvatarProps) {
  const px = avatarSize[size]
  const dot = Math.max(8, Math.round(px / 4))
  const accessibility = decorative
    ? { accessible: false, importantForAccessibility: 'no-hide-descendants' as const }
    : {
        accessible: true,
        accessibilityRole: 'image' as const,
        accessibilityLabel: name,
        importantForAccessibility: 'yes' as const,
      }
  return (
    <View style={{ width: px, height: px }} {...accessibility}>
      {src ? (
        <Image
          source={{ uri: src }}
          style={[styles.image, { width: px, height: px }]}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={src}
          transition={motion.duration.fast}
          accessible={false}
        />
      ) : (
        <View style={[styles.fallback, { width: px, height: px }]}>
          <Text style={[FONT[size], text.muted]} numberOfLines={1}>
            {initials(name)}
          </Text>
        </View>
      )}
      {live ? (
        <View
          style={[
            styles.live,
            { width: dot, height: dot, borderRadius: dot / 2, borderWidth: borderWidth.indicator },
          ]}
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  image: { borderRadius: radius.avatar, backgroundColor: colors.subtleFill },
  fallback: {
    borderRadius: radius.avatar,
    backgroundColor: colors.subtleFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  live: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    backgroundColor: colors.live,
    borderColor: colors.background,
  },
})
