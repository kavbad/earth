/**
 * A post anywhere it appears (spec §92; SCREEN 01–05, 07, 22): avatar, name, minimal metadata
 * (relative time · audience), generous text, large media, the place line, subdued actions. No
 * thick rounded card around the whole post; feed objects are separated by space and a hairline.
 */
import type { PostId, PostViewDto } from '@earth/domain'
import { colors, copy, formatHandle, relativeTime, space, spacing, typography } from '@earth/ui'
import { useRouter } from 'expo-router'
import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { postCopy } from '@/features/feed/copy'
import type { PostActionContext } from '@/features/feed/hooks/usePostActions'
import { postRoute, profileRoute } from '@/features/feed/routes'

import { Avatar, Icon, text } from '@/components/ui'
import { PostActions } from './PostActions'
import { PostMedia } from './PostMedia'

export const POST_CARD_VARIANTS = ['feed', 'detail', 'reply'] as const
export type PostCardVariant = (typeof POST_CARD_VARIANTS)[number]

export interface PostCardProps {
  readonly view: PostViewDto
  readonly context: PostActionContext
  readonly variant?: PostCardVariant
  /** Reported when the person opens the post (feed and reply variants open the thread). */
  readonly onOpen?: (() => void) | undefined
  readonly onReply?: (() => void) | undefined
  readonly onHidden?: ((postId: PostId) => void) | undefined
}

/** `2h · Friends` — relative time then the audience the author chose (spec §29). */
export function postMetaLine(view: PostViewDto, now: Date = new Date()): string {
  return [relativeTime(view.post.createdAt, now), copy.audiences[view.post.audience]].join(' · ')
}

/** `Dolores Park · Mission` — an explicit place tag, never a coordinate (spec §74). */
export function placeLine(view: PostViewDto): string | null {
  if (view.place === null) return null
  return view.place.areaName === null
    ? view.place.name
    : `${view.place.name} · ${view.place.areaName}`
}

function PostCardView({
  view,
  context,
  variant = 'feed',
  onOpen,
  onReply,
  onHidden,
}: PostCardProps) {
  const router = useRouter()
  const detail = variant === 'detail'
  const author = view.author
  const meta = postMetaLine(view)
  const place = placeLine(view)
  const body = view.post.text?.trim() ?? ''

  const openProfile = () => router.push(profileRoute(author.handle))
  const openPost = () => {
    onOpen?.()
    router.push(postRoute(view.post.id))
  }

  const content = (
    <>
      {body !== '' ? (
        <Text style={[detail ? styles.detailText : text.body, text.primary]}>{body}</Text>
      ) : null}
      <PostMedia media={view.media} authorName={author.displayName} spaced={body !== ''} />
    </>
  )

  return (
    <View
      style={[styles.card, variant === 'reply' ? styles.replyPadding : styles.feedPadding]}
      accessibilityLabel={`${author.displayName}: ${
        body === '' ? postCopy.photoAlt(author.displayName) : body.slice(0, 80)
      }`}
    >
      <Pressable
        onPress={openProfile}
        accessibilityRole="button"
        accessibilityLabel={author.displayName}
        style={styles.avatar}
      >
        <Avatar
          name={author.displayName}
          src={author.avatarUrl}
          size={variant === 'reply' ? 'small' : 'medium'}
          decorative
        />
      </Pressable>
      <View style={styles.main}>
        <View style={styles.header}>
          <Pressable
            onPress={openProfile}
            accessibilityRole="link"
            accessibilityLabel={author.displayName}
          >
            <Text style={[text.bodyMedium, text.primary]} numberOfLines={1}>
              {author.displayName}
            </Text>
          </Pressable>
          {detail ? (
            <>
              <Text style={[text.secondary, text.muted]} numberOfLines={1}>
                {formatHandle(author.handle)}
              </Text>
              <View style={styles.human}>
                <Icon name="check" size="small" color={colors.textSecondary} />
                <Text style={[text.meta, text.muted]}>{copy.human}</Text>
              </View>
            </>
          ) : null}
          <Text style={[text.secondary, text.muted]}>{meta}</Text>
        </View>
        {detail ? (
          <View>{content}</View>
        ) : (
          <Pressable
            onPress={openPost}
            accessibilityRole="button"
            accessibilityLabel={postCopy.openPost}
          >
            {content}
          </Pressable>
        )}
        {place !== null ? (
          <View style={styles.place}>
            <Icon name="location" size="small" color={colors.textSecondary} />
            <Text style={[text.secondary, text.muted]} numberOfLines={1}>
              {place}
            </Text>
          </View>
        ) : null}
        <PostActions view={view} context={context} onReply={onReply} onHidden={onHidden} />
      </View>
    </View>
  )
}

export const PostCard = memo(PostCardView)

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    gap: space[3],
    paddingHorizontal: spacing.screenMargin,
    backgroundColor: colors.background,
  },
  feedPadding: { paddingVertical: space[4] },
  replyPadding: { paddingVertical: space[3] },
  avatar: { flexShrink: 0 },
  main: { flex: 1, minWidth: 0, gap: space[2] },
  header: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: space[2],
  },
  human: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  place: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  /** Section size at body weight: the post itself reads larger on its own screen. */
  detailText: {
    fontSize: typography.section.size,
    lineHeight: typography.section.lineHeight,
    fontWeight: '400',
  },
})
