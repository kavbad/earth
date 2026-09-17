/**
 * The inline reply composer at the foot of a post (SCREEN 07): one line, audience inherited from
 * the root (never wider, spec §72), a way to the full composer for photos. Visitors see the row
 * and meet the claim sheet when they touch it (spec §43).
 */
import type { PostDetailDto } from '@earth/domain'
import {
  borderWidth,
  colors,
  copy,
  radius,
  space,
  spacing,
  touchTarget,
  typography,
} from '@earth/ui'
import { useRouter } from 'expo-router'
import { type RefObject, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { postCopy } from '@/features/feed/copy'
import { lightTap } from '@/lib/haptics'
import { useCreatePost } from '@/features/feed/hooks/usePost'
import { composeHref } from '@/features/feed/routes'
import { useFeedShell } from '@/features/feed/shell'
import { postText } from '@/features/feed/state/media'

import { IconButton, text } from '@/components/ui'

export interface ReplyComposerProps {
  readonly parent: PostDetailDto
  readonly inputRef?: RefObject<TextInput | null>
  readonly onPosted?: (() => void) | undefined
}

const MAX_INPUT_HEIGHT = 136
/** The meta-size link reaches the 44pt target through its hit slop. */
const META_LINK_HIT_SLOP = {
  top: (touchTarget - typography.meta.lineHeight) / 2,
  bottom: (touchTarget - typography.meta.lineHeight) / 2,
  left: space[2],
  right: space[2],
}

export function ReplyComposer({ parent, inputRef, onPosted }: ReplyComposerProps) {
  const shell = useFeedShell()
  const router = useRouter()
  const create = useCreatePost()
  const insets = useSafeAreaInsets()
  const [body, setBody] = useState('')
  const audience = parent.post.audience
  const closed = parent.post.replyPolicy === 'none'
  const ready = postText(body) !== null && !create.pending

  const submit = async () => {
    const value = postText(body)
    if (value === null || create.pending) return
    if (!shell.requireHuman('post')) return
    lightTap()
    try {
      await create.create({
        type: 'text',
        text: value,
        audience,
        placeId: null,
        media: [],
        parentPostId: parent.post.id,
      })
      setBody('')
      onPosted?.()
    } catch {
      shell.toast(postCopy.couldntPost)
    }
  }

  if (closed) {
    return <Text style={[text.secondary, text.muted, styles.closed]}>{postCopy.repliesClosed}</Text>
  }

  return (
    <View style={[styles.wrap, { paddingBottom: insets.bottom }]}>
      <View style={styles.metaRow}>
        <Text style={[text.meta, text.muted]}>
          {postCopy.audienceCapped(copy.audiences[audience])}
        </Text>
        {shell.isHuman ? (
          <Pressable
            onPress={() => router.push(composeHref({ replyTo: parent.post.id }))}
            accessibilityRole="link"
            accessibilityLabel={postCopy.addPhotoVideo}
            hitSlop={META_LINK_HIT_SLOP}
          >
            <Text style={[text.meta, text.muted]}>{postCopy.addPhotoVideo}</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.inputRow}>
        <TextInput
          ref={inputRef}
          value={body}
          onChangeText={setBody}
          onFocus={() => {
            if (!shell.isHuman) shell.openClaim('post')
          }}
          placeholder={postCopy.replyPlaceholder}
          placeholderTextColor={colors.textSecondary}
          multiline
          accessibilityLabel={copy.reply}
          style={[text.body, text.primary, styles.input]}
        />
        <IconButton
          name="send"
          label={copy.reply}
          filled
          disabled={!ready}
          busy={create.pending}
          onPress={() => void submit()}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.background,
    borderTopWidth: borderWidth.hairline,
    borderTopColor: colors.separator,
  },
  closed: { paddingHorizontal: spacing.screenMargin, paddingVertical: space[3] },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    paddingHorizontal: spacing.screenMargin,
    paddingTop: space[2],
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: space[1],
    paddingHorizontal: space[2],
    paddingVertical: space[2],
  },
  input: {
    flex: 1,
    minHeight: touchTarget - space[1],
    maxHeight: MAX_INPUT_HEIGHT,
    paddingHorizontal: space[4],
    paddingVertical: space[2],
    borderRadius: radius.medium,
    backgroundColor: colors.subtleFill,
  },
})
