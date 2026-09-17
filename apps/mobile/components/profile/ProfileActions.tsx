/**
 * SCREEN 22 actions: Add Friend / Requested / Accept / Friends, Follow / Following, Message when
 * allowed, More. Friend is not Follow (spec §128): both are offered, neither implies the other.
 * Visitors meet the claim sheet (spec §43).
 */
import type { ProfileDto } from '@earth/domain'
import { colors, copy, space } from '@earth/ui'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { Button, IconButton, text } from '@/components/ui'
import { profileCopy } from '@/features/feed/copy'
import { useProfileActions } from '@/features/feed/hooks/useProfile'
import { conversationRoute } from '@/features/feed/routes'
import { useFeedShell } from '@/features/feed/shell'
import { friendActionFor } from '@/features/feed/state/profile'
import { lightTap } from '@/lib/haptics'

import { ProfileMoreSheet } from './ProfileMoreSheet'

export interface ProfileActionsProps {
  readonly profile: ProfileDto
}

export function ProfileActions({ profile }: ProfileActionsProps) {
  const shell = useFeedShell()
  const router = useRouter()
  const actions = useProfileActions(profile, 'profile')
  const [moreOpen, setMoreOpen] = useState(false)
  const [messaging, setMessaging] = useState(false)
  const { relationship } = profile
  const friend = friendActionFor(relationship)

  const message = async () => {
    if (!shell.requireHuman('profile')) return
    lightTap()
    setMessaging(true)
    try {
      const conversation = await shell.earth.conversations.directWith(profile.identity.humanId)
      router.push(conversationRoute(conversation.id))
    } catch {
      shell.toast(profileCopy.couldntChange)
    } finally {
      setMessaging(false)
    }
  }

  const friendLabel =
    friend === 'friends'
      ? copy.profileActions.friends
      : friend === 'requested'
        ? profileCopy.requested
        : friend === 'accept'
          ? profileCopy.accept
          : copy.profileActions.addFriend

  return (
    <View style={styles.row}>
      {relationship.isBlocked ? (
        <Text style={[text.secondary, text.muted, styles.blocked]}>{profileCopy.blocked}</Text>
      ) : (
        <>
          <Button
            variant={friend === 'add' || friend === 'accept' ? 'primary' : 'secondary'}
            loading={actions.busy}
            selected={friend === 'friends'}
            label={friendLabel}
            onPress={() => {
              if (friend === 'add') void actions.addFriend()
              else if (friend === 'accept') void actions.acceptFriend()
              else setMoreOpen(true)
            }}
          />
          <Button
            variant="secondary"
            disabled={actions.busy}
            selected={relationship.isFollowing}
            label={
              relationship.isFollowing ? copy.profileActions.following : copy.profileActions.follow
            }
            onPress={() => void actions.setFollow(!relationship.isFollowing)}
          />
          {profile.canMessage ? (
            <Button
              variant="secondary"
              loading={messaging}
              label={copy.profileActions.message}
              onPress={() => void message()}
            />
          ) : null}
        </>
      )}
      <IconButton
        name="more"
        label={copy.profileActions.more}
        color={colors.textSecondary}
        onPress={() => setMoreOpen(true)}
      />
      <ProfileMoreSheet
        open={moreOpen}
        profile={profile}
        busy={actions.busy}
        onRemoveFriend={actions.removeFriend}
        onUnfollow={() => actions.setFollow(false)}
        onBlock={actions.block}
        onUnblock={actions.unblock}
        onReport={actions.report}
        onClose={() => setMoreOpen(false)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space[2] },
  blocked: { minHeight: space[10], textAlignVertical: 'center' },
})
