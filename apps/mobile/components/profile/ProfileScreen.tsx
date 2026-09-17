/**
 * SCREEN 22 — profile hierarchy: avatar, display name, handle (with the Human indicator), city
 * if shared, mutual friends, actions; then "Now" posts. Follower numbers are visually secondary.
 * Visitors see public profiles and meet the claim sheet on every action (spec §43). A failed
 * refresh keeps what is cached (spec §110).
 */
import type { PostViewDto } from '@earth/domain'
import { colors, copy, formatHandle, motion, mutualLine, space, spacing } from '@earth/ui'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useRef } from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'

import {
  Avatar,
  Button,
  EmptyState,
  Icon,
  IconButton,
  ScreenHeader,
  Skeleton,
  StatusLine,
  text,
} from '@/components/ui'
import { feedCopy, profileCopy } from '@/features/feed/copy'
import { useBack } from '@/features/feed/hooks/useBack'
import { useProfile } from '@/features/feed/hooks/useProfile'
import { useProfilePosts } from '@/features/feed/hooks/useProfilePosts'
import { YOU_ROUTE } from '@/features/feed/routes'
import { useFeedShell } from '@/features/feed/shell'
import {
  profileActionsAvailable,
  profileConnectionLine,
  profileCountsLine,
  viewerRelationFor,
} from '@/features/feed/state/profile'

import { ProfileActions } from './ProfileActions'
import {
  ProfilePostItem,
  ProfilePostSeparator,
  ProfilePostsEmpty,
  ProfilePostsFooter,
  ProfilePostsTitle,
  profilePostKey,
} from './ProfilePosts'

export interface ProfileScreenProps {
  readonly handle: string
}

function ProfileSkeleton() {
  return (
    <View
      style={styles.skeleton}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Skeleton width={space[12] + space[12]} height={space[12] + space[12]} round />
      <Skeleton width="50%" height={space[6]} />
      <Skeleton width="33%" height={space[4]} />
    </View>
  )
}

export function ProfileScreen({ handle }: ProfileScreenProps) {
  const shell = useFeedShell()
  const { track } = shell
  const router = useRouter()
  const back = useBack()
  const { profile, loading, failed, refreshFailed, refresh } = useProfile(handle)
  const posts = useProfilePosts(profile)

  const viewed = useRef<string | null>(null)
  useEffect(() => {
    if (profile === undefined || viewed.current === profile.identity.humanId) return
    viewed.current = profile.identity.humanId
    track('profile_viewed', {
      profileHumanId: profile.identity.humanId,
      relation: viewerRelationFor(profile),
      source: 'profile',
    })
  }, [profile, track])

  const renderItem = useCallback(
    ({ item }: { item: PostViewDto }) => <ProfilePostItem view={item} />,
    [],
  )

  const identity = profile?.identity
  const header = (
    <ScreenHeader
      title={identity?.displayName ?? ''}
      leading={<IconButton name="back" label={feedCopy.back} onPress={back} />}
    />
  )
  const offlineLine = shell.online ? copy.couldntRefresh : copy.waitingForConnection

  if (profile === undefined) {
    return (
      <View style={styles.screen}>
        {header}
        {!shell.online ? <StatusLine message={copy.waitingForConnection} banner /> : null}
        {failed ? (
          <EmptyState
            title={profileCopy.profileUnavailable}
            action={<Button variant="quiet" label={feedCopy.retry} onPress={refresh} />}
          />
        ) : loading ? (
          <ProfileSkeleton />
        ) : null}
      </View>
    )
  }

  const connection = profileConnectionLine(
    profile,
    (count) => mutualLine(count, null),
    profileCopy.sharedGroups,
  )
  const bio = profile.identity.bio?.trim() ?? ''
  const listHeader = (
    <View>
      {refreshFailed ? <StatusLine message={offlineLine} /> : null}
      <View style={styles.identity}>
        <Avatar
          name={profile.identity.displayName}
          src={profile.identity.avatarUrl}
          size="profile"
        />
        <View style={styles.lines}>
          <Text style={[text.title, text.primary]}>{profile.identity.displayName}</Text>
          <View style={styles.handleRow}>
            <Text style={[text.secondary, text.muted]}>
              {formatHandle(profile.identity.handle)}
            </Text>
            <View style={styles.human}>
              <Icon name="check" size="small" color={colors.textSecondary} />
              <Text style={[text.meta, text.muted]}>{copy.human}</Text>
            </View>
          </View>
          {profile.identity.cityName !== null ? (
            <View style={styles.city}>
              <Icon name="location" size="small" color={colors.textSecondary} />
              <Text style={[text.secondary, text.muted]}>{profile.identity.cityName}</Text>
            </View>
          ) : null}
          {connection !== '' ? (
            <Text style={[text.secondary, text.muted]}>{connection}</Text>
          ) : null}
          {bio !== '' ? <Text style={[text.body, text.primary, styles.bio]}>{bio}</Text> : null}
        </View>
        {profile.relationship.isSelf ? (
          <Pressable
            onPress={() => router.push(YOU_ROUTE)}
            accessibilityRole="link"
            accessibilityLabel={profileCopy.editProfile}
            hitSlop={space[2]}
            style={styles.edit}
          >
            <Text style={[text.secondary, text.muted]}>{profileCopy.editProfile}</Text>
          </Pressable>
        ) : profileActionsAvailable(profile) || profile.relationship.isBlocked ? (
          <ProfileActions profile={profile} />
        ) : null}
        <Text style={[text.meta, text.muted]}>
          {profileCountsLine(profile, {
            friends: profileCopy.friendsCount,
            followers: profileCopy.followersCount,
            following: profileCopy.followingCount,
          })}
        </Text>
      </View>
      <ProfilePostsTitle />
    </View>
  )

  return (
    <View style={styles.screen}>
      {header}
      {!shell.online ? <StatusLine message={copy.waitingForConnection} banner /> : null}
      <Animated.View entering={FadeIn.duration(motion.duration.base)} style={styles.fill}>
        <FlatList
          data={posts.posts}
          keyExtractor={profilePostKey}
          renderItem={renderItem}
          ItemSeparatorComponent={ProfilePostSeparator}
          ListHeaderComponent={listHeader}
          ListEmptyComponent={<ProfilePostsEmpty posts={posts} online={shell.online} />}
          ListFooterComponent={<ProfilePostsFooter posts={posts} />}
          onEndReached={posts.loadMore}
          onEndReachedThreshold={0.6}
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={refresh}
              tintColor={colors.textSecondary}
            />
          }
          windowSize={7}
          initialNumToRender={6}
          maxToRenderPerBatch={6}
          removeClippedSubviews
          accessibilityLabel={profile.identity.displayName}
        />
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  fill: { flex: 1 },
  skeleton: { paddingHorizontal: spacing.screenMargin, paddingVertical: space[6], gap: space[4] },
  identity: {
    paddingHorizontal: spacing.screenMargin,
    paddingVertical: space[6],
    gap: space[4],
  },
  lines: { gap: space[1] },
  handleRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: space[2] },
  human: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  city: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
  bio: { marginTop: space[2] },
  edit: { alignSelf: 'flex-start', minHeight: space[8], justifyContent: 'center' },
})
