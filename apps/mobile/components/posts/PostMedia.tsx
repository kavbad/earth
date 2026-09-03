/**
 * Spec §92: media is large — one item runs the full content width at its own aspect ratio; more
 * items sit in a tight two-column grid. Never a thick card around the whole post. Images go
 * through `expo-image` (memory + disk cache); videos through `expo-av` with the system controls.
 */
import type { PostMediaDto } from '@earth/domain'
import { colors, motion, radius, space } from '@earth/ui'
import { ResizeMode, Video } from 'expo-av'
import { Image } from 'expo-image'
import { StyleSheet, View } from 'react-native'

import { postCopy } from '@/features/feed/copy'

export interface PostMediaProps {
  readonly media: readonly PostMediaDto[]
  readonly authorName: string
  readonly spaced?: boolean
}

/** Aspect ratio from the stored dimensions; a square when unknown so layout never jumps. */
export function mediaAspect(item: Pick<PostMediaDto, 'width' | 'height'>): number {
  return item.width > 0 && item.height > 0 ? item.width / item.height : 1
}

const GRID_GAP = 2

function MediaItem({
  item,
  authorName,
  single,
}: {
  readonly item: PostMediaDto
  readonly authorName: string
  readonly single: boolean
}) {
  const aspectRatio = single ? mediaAspect(item) : 1
  if (item.mediaType === 'video') {
    return (
      <Video
        source={{ uri: item.url }}
        style={[styles.item, { aspectRatio }]}
        resizeMode={ResizeMode.COVER}
        useNativeControls
        shouldPlay={false}
        isMuted
        accessibilityLabel={postCopy.videoLabel(authorName)}
      />
    )
  }
  if (item.mediaType === 'audio') return null
  return (
    <Image
      source={{ uri: item.url }}
      style={[styles.item, { aspectRatio }]}
      contentFit="cover"
      cachePolicy="memory-disk"
      recyclingKey={item.id}
      transition={motion.duration.fast}
      accessible
      accessibilityLabel={postCopy.photoAlt(authorName)}
    />
  )
}

export function PostMedia({ media, authorName, spaced = false }: PostMediaProps) {
  if (media.length === 0) return null
  const single = media.length === 1
  return (
    <View style={[styles.wrap, spaced && styles.spaced, !single && styles.grid]}>
      {media.map((item) => (
        <View key={item.id} style={single ? styles.full : styles.cell}>
          <MediaItem item={item} authorName={authorName} single={single} />
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden', borderRadius: radius.medium },
  spaced: { marginTop: space[3] },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP },
  full: { width: '100%' },
  cell: { width: '49.5%' },
  item: { width: '100%', backgroundColor: colors.subtleFill },
})
