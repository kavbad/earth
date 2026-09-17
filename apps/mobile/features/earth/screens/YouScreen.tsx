/**
 * SCREEN 24 — You: your own profile (avatar, name, handle, city), your posts, friend / follow
 * counts quietly, Settings, and the "Your Earth" scaffold that opens the map on your home city
 * with your Moments. No lifetime product yet (spec §133).
 */
import type { FeedPostCardDto } from '@earth/domain'
import { colors, copy, formatHandle, relativeTime, space, spacing } from '@earth/ui'
import { useRouter } from 'expo-router'
import { memo, useCallback, useEffect, useRef } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'

import { ShellScreenHeader } from '@/components/shell/ScreenHeader'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Icon } from '@/components/ui/Icon'
import { ListRow } from '@/components/ui/ListRow'
import { Screen } from '@/components/ui/Screen'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatusLine } from '@/components/ui/StatusLine'
import { text } from '@/components/ui/text'

import { earthCopy, youCopy } from '../copy'
import { lightTap } from '../haptics'
import { useOwnPosts, useYouProfile } from '../hooks/useYou'
import { CLAIM_ROUTE, YOU_ROUTES, earthHref, postRoute } from '../routes'
import { useEarthShell } from '../shell'

export const POST_ROW_HEIGHT = 96

function keyExtractor(card: FeedPostCardDto): string {
  return card.id
}

function getItemLayout(_data: ArrayLike<FeedPostCardDto> | null | undefined, index: number) {
  return { length: POST_ROW_HEIGHT, offset: POST_ROW_HEIGHT * index, index }
}

/** `3 hours ago · Dolores Park · Friends` */
export function postMetaLine(card: FeedPostCardDto, now: Date = new Date()): string {
  return [
    relativeTime(card.post.createdAt, now),
    card.place?.name ?? null,
    copy.audiences[card.post.audience],
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(' · ')
}

function PostRowBase({
  card,
  onOpen,
}: {
  readonly card: FeedPostCardDto
  readonly onOpen: (card: FeedPostCardDto) => void
}) {
  const body = card.post.text !== null && card.post.text !== '' ? card.post.text : null
  const mediaLine =
    card.media.length === 0
      ? null
      : card.media.length === 1
        ? (card.media[0]?.mediaType ?? null)
        : `${card.media.length} ${card.media[0]?.mediaType ?? 'media'}`
  return (
    <Pressable
      onPress={() => onOpen(card)}
      accessibilityRole="button"
      accessibilityLabel={body ?? mediaLine ?? youCopy.posts}
      style={({ pressed }) => [styles.postRow, pressed && styles.pressed]}
    >
      {body !== null ? (
        <Text style={[text.body, text.primary]} numberOfLines={2}>
          {body}
        </Text>
      ) : null}
      {mediaLine !== null ? (
        <Text style={[text.secondary, text.muted]} numberOfLines={1}>
          {mediaLine}
        </Text>
      ) : null}
      <Text style={[text.meta, text.muted]} numberOfLines={1}>
        {postMetaLine(card)}
      </Text>
    </Pressable>
  )
}
const PostRow = memo(PostRowBase)

export function YouScreen() {
  const shell = useEarthShell()
  const router = useRouter()
  const identity = shell.identity
  const humanId = shell.viewerId
  const profile = useYouProfile()
  const posts = useOwnPosts()

  const viewed = useRef(false)
  const { track } = shell
  useEffect(() => {
    if (viewed.current || humanId === null) return
    viewed.current = true
    track('profile_viewed', { profileHumanId: humanId, relation: 'self', source: 'profile' })
  }, [humanId, track])

  const openSettings = useCallback(() => router.push(YOU_ROUTES.settings), [router])
  const openPost = useCallback(
    (card: FeedPostCardDto) => {
      lightTap()
      router.push(postRoute(card.post.id))
    },
    [router],
  )
  const renderItem = useCallback(
    ({ item }: { item: FeedPostCardDto }) => <PostRow card={item} onOpen={openPost} />,
    [openPost],
  )

  if (shell.sessionStatus === 'loading') {
    return (
      <Screen>
        <ShellScreenHeader title={copy.tabs.you} />
        <View style={styles.skeleton} accessibilityElementsHidden>
          <Skeleton width={space[16] + space[8]} height={space[16] + space[8]} round />
          <Skeleton width="50%" height={space[6]} />
          <Skeleton width="33%" height={space[4]} />
        </View>
      </Screen>
    )
  }

  if (!shell.isHuman || identity === null) {
    const claiming = shell.roleKind === 'claiming'
    return (
      <Screen>
        <ShellScreenHeader title={copy.tabs.you} />
        <EmptyState
          title={claiming ? youCopy.finishClaim : youCopy.notOnEarthYet}
          action={
            claiming ? (
              <Button
                variant="primary"
                label={youCopy.finishClaim}
                onPress={() => router.push(CLAIM_ROUTE)}
              />
            ) : (
              <Button
                variant="primary"
                label={copy.claimYourPlace}
                onPress={() => shell.openClaim('profile')}
              />
            )
          }
        />
      </Screen>
    )
  }

  const counts = profile.profile?.counts ?? null

  const header = (
    <View>
      <View style={styles.profile} accessibilityLabel={copy.tabs.you}>
        <Avatar name={identity.displayName} src={identity.avatarUrl} size="profile" decorative />
        <View>
          <Text style={[text.title, text.primary]} accessibilityRole="header">
            {identity.displayName}
          </Text>
          <Text style={[text.secondary, text.muted]}>{formatHandle(identity.handle)}</Text>
          {identity.cityName !== null ? (
            <Text style={[text.secondary, text.muted]}>{identity.cityName}</Text>
          ) : null}
        </View>
        {identity.bio !== null && identity.bio !== '' ? (
          <Text style={[text.body, text.primary]}>{identity.bio}</Text>
        ) : null}
        {counts !== null ? (
          <Text style={[text.meta, text.muted]}>
            {youCopy.counts(counts.friends, counts.followers, counts.following)}
          </Text>
        ) : profile.failed ? (
          <StatusLine
            message={copy.couldntRefresh}
            actionLabel={earthCopy.retry}
            onAction={profile.refetch}
          />
        ) : null}
      </View>
      <ListRow
        leading={<Icon name="earth" />}
        title={copy.yourEarth}
        subtitle={youCopy.yourEarthLine}
        trailing={<Icon name="chevron" size="small" color={colors.textSecondary} />}
        onPress={() => router.push(earthHref({ you: true }))}
      />
      <ListRow
        title={copy.settings.title}
        trailing={<Icon name="chevron" size="small" color={colors.textSecondary} />}
        onPress={openSettings}
      />
      <View style={styles.postsHead}>
        <Text style={[text.section, text.primary]} accessibilityRole="header">
          {youCopy.posts}
        </Text>
      </View>
      {posts.failed ? (
        <StatusLine
          message={copy.couldntRefresh}
          actionLabel={earthCopy.retry}
          onAction={posts.refetch}
        />
      ) : !posts.loaded ? (
        <View style={styles.postsSkeleton} accessibilityElementsHidden>
          <Skeleton width="75%" height={space[4]} />
          <Skeleton width="50%" height={space[4]} />
        </View>
      ) : posts.posts.length === 0 ? (
        <EmptyState title={youCopy.noPostsYet} />
      ) : null}
    </View>
  )

  return (
    <Screen accessibilityLabel={copy.tabs.you}>
      <ShellScreenHeader
        title={copy.tabs.you}
        trailing={
          <Button variant="quiet" compact label={copy.settings.title} onPress={openSettings} />
        }
      />
      <FlatList
        data={posts.posts}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        ListHeaderComponent={header}
        windowSize={7}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        removeClippedSubviews
        contentContainerStyle={styles.list}
        accessibilityLabel={youCopy.posts}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  skeleton: { paddingHorizontal: spacing.screenMargin, paddingVertical: space[6], gap: space[3] },
  profile: { paddingHorizontal: spacing.screenMargin, paddingVertical: space[6], gap: space[3] },
  postsHead: {
    paddingHorizontal: spacing.screenMargin,
    paddingTop: space[6],
    paddingBottom: space[2],
  },
  postsSkeleton: {
    paddingHorizontal: spacing.screenMargin,
    paddingVertical: space[4],
    gap: space[3],
  },
  postRow: {
    height: POST_ROW_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: spacing.screenMargin,
    gap: space[1],
    backgroundColor: colors.background,
  },
  pressed: { backgroundColor: colors.subtleFill },
  list: { paddingBottom: space[10] },
})
