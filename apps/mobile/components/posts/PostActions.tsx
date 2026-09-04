/**
 * The subdued actions row (spec §92): React · Reply · Share · More as plain text, counts only
 * when there is something to count. Visitors meet the claim sheet on react/reply (spec §43).
 */
import type { PostViewDto } from '@earth/domain'
import { colors, copy, space, touchTarget } from '@earth/ui'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { postCopy } from '@/features/feed/copy'
import {
  type PostActionContext,
  usePostActions,
  useReaction,
} from '@/features/feed/hooks/usePostActions'
import { postRoute } from '@/features/feed/routes'
import { useFeedShell } from '@/features/feed/shell'

import { Icon, text } from '@/components/ui'
import { PostMoreSheet } from './PostMoreSheet'

export interface PostActionsProps {
  readonly view: PostViewDto
  readonly context: PostActionContext
  /** Replies open the thread; on the detail screen the reply control focuses the composer. */
  readonly onReply?: (() => void) | undefined
  readonly onHidden?: ((postId: PostViewDto['post']['id']) => void) | undefined
}

function Action({
  label,
  count,
  onPress,
  active = false,
  accessibilityLabel,
  selected,
}: {
  readonly label: string
  readonly count?: number
  readonly onPress: () => void
  readonly active?: boolean
  readonly accessibilityLabel?: string
  readonly selected?: boolean
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      hitSlop={space[1]}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}
    >
      <Text style={[text.secondary, active ? text.primary : text.muted]}>{label}</Text>
      {count !== undefined && count > 0 ? (
        <Text style={[text.secondary, active ? text.primary : text.muted]}>{count}</Text>
      ) : null}
    </Pressable>
  )
}

export function PostActions({ view, context, onReply, onHidden }: PostActionsProps) {
  const shell = useFeedShell()
  const router = useRouter()
  const reaction = useReaction(view, context)
  const actions = usePostActions(onHidden)
  const [moreOpen, setMoreOpen] = useState(false)
  const isOwn = shell.viewerId !== null && shell.viewerId === view.author.humanId

  const reply = () => {
    if (onReply !== undefined) {
      if (shell.requireHuman('post')) onReply()
      return
    }
    router.push(postRoute(view.post.id))
  }

  return (
    <View style={styles.row}>
      <Action
        label={reaction.reacted ? postCopy.reacted : postCopy.react}
        count={reaction.count}
        active={reaction.reacted}
        selected={reaction.reacted}
        accessibilityLabel={`${reaction.reacted ? postCopy.reacted : postCopy.react}${
          reaction.count > 0 ? `, ${postCopy.reactionCount(reaction.count)}` : ''
        }`}
        onPress={reaction.toggle}
      />
      <Action
        label={copy.reply}
        count={view.replyCount}
        accessibilityLabel={`${copy.replies}${
          view.replyCount > 0 ? `, ${postCopy.replyCount(view.replyCount)}` : ''
        }`}
        onPress={reply}
      />
      <Action label={postCopy.share} onPress={() => void actions.share(view)} />
      <View style={styles.spacer} />
      <Pressable
        onPress={() => setMoreOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={postCopy.more}
        hitSlop={space[1]}
        style={({ pressed }) => [styles.more, pressed && styles.pressed]}
      >
        <Icon name="more" size="small" color={colors.textSecondary} />
      </Pressable>
      <PostMoreSheet
        open={moreOpen}
        view={view}
        isOwn={isOwn}
        busy={actions.busy}
        onReport={(reason) => actions.report(view, reason)}
        onHide={() => actions.hide(view, context)}
        onBlock={() => actions.blockAuthor(view, context)}
        onDelete={() => actions.remove(view)}
        onClose={() => setMoreOpen(false)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space[2], marginLeft: -space[2] },
  action: {
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    paddingHorizontal: space[2],
  },
  more: {
    minHeight: touchTarget,
    minWidth: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.6 },
  spacer: { flex: 1 },
})
