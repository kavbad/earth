/**
 * SCREEN 22 "Now": the profile's posts as the same post objects as Home — the list rows, the
 * section title, and the loading / failed / empty states the profile list composes.
 */
import type { PostViewDto } from '@earth/domain'
import { borderWidth, colors, copy, space, spacing } from '@earth/ui'
import { memo } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { PostCard } from '@/components/posts/PostCard'
import { Button, EmptyState, Skeleton, Spinner, StatusLine, text } from '@/components/ui'
import { feedCopy, profileCopy } from '@/features/feed/copy'
import type { ProfilePosts as ProfilePostsController } from '@/features/feed/hooks/useProfilePosts'

function ProfilePostItemView({ view }: { readonly view: PostViewDto }) {
  return <PostCard view={view} context={{ source: 'profile' }} />
}

export const ProfilePostItem = memo(ProfilePostItemView)

export function profilePostKey(view: PostViewDto): string {
  return view.post.id
}

export function ProfilePostsTitle() {
  return (
    <View style={styles.titleBox}>
      <Text style={[text.section, text.primary]} accessibilityRole="header">
        {profileCopy.now}
      </Text>
    </View>
  )
}

export function ProfilePostSeparator() {
  return <View style={styles.separator} />
}

export function ProfilePostsEmpty({
  posts,
  online,
}: {
  readonly posts: ProfilePostsController
  readonly online: boolean
}) {
  if (posts.loading) {
    return (
      <View
        style={styles.skeleton}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Skeleton width="33%" height={space[4]} />
        <Skeleton height={space[16]} />
      </View>
    )
  }
  if (posts.failed) {
    return <StatusLine message={online ? copy.couldntRefresh : copy.waitingForConnection} />
  }
  return <EmptyState title={profileCopy.noPostsYet} />
}

export function ProfilePostsFooter({ posts }: { readonly posts: ProfilePostsController }) {
  if (posts.loadingMore) return <Spinner label={feedCopy.loadingMore} />
  if (posts.hasMore && posts.posts.length > 0) {
    return (
      <View style={styles.more}>
        <Button variant="quiet" label={feedCopy.loadingMore} onPress={posts.loadMore} />
      </View>
    )
  }
  return <View style={styles.footerSpace} />
}

const styles = StyleSheet.create({
  titleBox: {
    paddingHorizontal: spacing.screenMargin,
    paddingTop: space[4],
    paddingBottom: space[1],
    borderTopWidth: borderWidth.hairline,
    borderTopColor: colors.separator,
  },
  separator: {
    marginHorizontal: spacing.screenMargin,
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: colors.separator,
  },
  skeleton: { paddingHorizontal: spacing.screenMargin, paddingVertical: space[4], gap: space[3] },
  more: { alignItems: 'center', paddingVertical: space[2] },
  footerSpace: { height: space[6] },
})
