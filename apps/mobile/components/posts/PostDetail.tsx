/**
 * SCREEN 07 — post detail: author with the Human indicator, time, audience, text/media, place,
 * reactions, replies (inheriting the root audience) and the reply composer. Failure keeps what is
 * cached (spec §110).
 */
import type { PostId, PostViewDto } from '@earth/domain'
import { avatarSize, borderWidth, colors, copy, motion, space, spacing } from '@earth/ui'
import { useCallback, useEffect, useRef } from 'react'
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  type TextInput,
  View,
} from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'

import { feedCopy, postCopy } from '@/features/feed/copy'
import { useBack } from '@/features/feed/hooks/useBack'
import { usePost, useReplies } from '@/features/feed/hooks/usePost'
import { useFeedShell } from '@/features/feed/shell'

import {
  Button,
  EmptyState,
  IconButton,
  ScreenHeader,
  Skeleton,
  Spinner,
  StatusLine,
  text,
} from '@/components/ui'
import { PostCard } from './PostCard'
import { ReplyComposer } from './ReplyComposer'

export interface PostDetailProps {
  readonly postId: PostId
}

const NO_REPLIES: readonly PostViewDto[] = []

function DetailSkeleton() {
  return (
    <View style={styles.skeleton}>
      <Skeleton width={avatarSize.medium} height={avatarSize.medium} round />
      <View style={styles.skeletonLines}>
        <Skeleton width="33%" />
        <Skeleton height={space[16] + space[4]} />
      </View>
    </View>
  )
}

function Separator() {
  return <View style={styles.separator} />
}

export function PostDetail({ postId }: PostDetailProps) {
  const shell = useFeedShell()
  const back = useBack()
  const post = usePost(postId)
  const replies = useReplies(postId, post.detail?.replies ?? NO_REPLIES)
  const composer = useRef<TextInput | null>(null)
  const detail = post.detail

  const opened = useRef(false)
  useEffect(() => {
    if (opened.current || detail === undefined) return
    opened.current = true
    shell.track('post_opened', { postId, source: 'post' })
  }, [detail, postId, shell])

  const renderReply = useCallback(
    ({ item }: { item: PostViewDto }) => (
      <PostCard view={item} context={{ source: 'post' }} variant="reply" />
    ),
    [],
  )

  return (
    <View style={styles.screen}>
      <ScreenHeader
        title={detail === undefined ? copy.replies : detail.author.displayName}
        leading={<IconButton name="back" label={feedCopy.back} onPress={back} />}
      />
      {!shell.online ? <StatusLine message={copy.waitingForConnection} banner /> : null}
      {detail === undefined ? (
        post.failed ? (
          <EmptyState
            title={postCopy.postUnavailable}
            action={<Button variant="quiet" label={feedCopy.retry} onPress={post.refresh} />}
          />
        ) : (
          <DetailSkeleton />
        )
      ) : (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.screen}
        >
          <Animated.View entering={FadeIn.duration(motion.duration.base)} style={styles.screen}>
            <FlatList
              data={replies.replies}
              keyExtractor={(item) => item.post.id}
              renderItem={renderReply}
              ItemSeparatorComponent={Separator}
              keyboardShouldPersistTaps="handled"
              windowSize={7}
              initialNumToRender={8}
              maxToRenderPerBatch={8}
              ListHeaderComponent={
                <View>
                  {post.refreshFailed ? <StatusLine message={copy.couldntRefresh} /> : null}
                  <PostCard
                    view={detail}
                    context={{ source: 'post' }}
                    variant="detail"
                    onReply={() => composer.current?.focus()}
                    onHidden={back}
                  />
                  <View style={styles.repliesHeader}>
                    <Text style={[text.section, text.primary]} accessibilityRole="header">
                      {copy.replies}
                      {detail.replyCount > 0 ? (
                        <Text style={[text.secondary, text.muted]}>{`  ${detail.replyCount}`}</Text>
                      ) : null}
                    </Text>
                  </View>
                </View>
              }
              ListEmptyComponent={
                <Text style={[text.secondary, text.muted, styles.empty]}>
                  {replies.failed ? copy.couldntRefresh : postCopy.noRepliesYet}
                </Text>
              }
              ListFooterComponent={
                replies.hasMore ? (
                  <View style={styles.more}>
                    <Button
                      variant="quiet"
                      label={postCopy.loadMoreReplies}
                      loading={replies.loadingMore}
                      onPress={replies.loadMore}
                    />
                  </View>
                ) : replies.loadingMore ? (
                  <Spinner />
                ) : (
                  <View style={styles.footerSpace} />
                )
              }
            />
            <ReplyComposer parent={detail} inputRef={composer} />
          </Animated.View>
        </KeyboardAvoidingView>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  skeleton: {
    flexDirection: 'row',
    gap: space[3],
    paddingHorizontal: spacing.screenMargin,
    paddingVertical: space[4],
  },
  skeletonLines: { flex: 1, gap: space[3] },
  separator: {
    marginHorizontal: spacing.screenMargin,
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: colors.separator,
  },
  repliesHeader: {
    paddingHorizontal: spacing.screenMargin,
    paddingTop: space[4],
    paddingBottom: space[1],
    borderTopWidth: borderWidth.hairline,
    borderTopColor: colors.separator,
  },
  empty: { paddingHorizontal: spacing.screenMargin, paddingVertical: space[3] },
  more: { paddingHorizontal: spacing.screenMargin, paddingVertical: space[2] },
  footerSpace: { height: space[4] },
})
