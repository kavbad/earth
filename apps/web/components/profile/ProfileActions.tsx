'use client'

/**
 * SCREEN 22 actions: Add Friend / Requested / Accept / Friends, Follow / Following, Message when
 * allowed, More. Friend is not Follow (spec §128): both are offered, neither implies the other.
 * Visitors meet the claim sheet (spec §43).
 */
import type { ProfileDto } from '@earth/domain'
import { copy } from '@earth/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { conversationRoute } from '../../lib/routes'
import { useEarth } from '../../lib/providers/RuntimeProvider'
import { useSession } from '../../lib/providers/SessionProvider'
import { useClaimGate } from '../shell/ClaimSheet'
import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { useToast } from '../ui/Toast'
import { ProfileMoreSheet } from './ProfileMoreSheet'
import { profileCopy } from './copy'
import { useProfileActions } from './hooks/useProfile'
import { friendActionFor } from './state/relationship'

export interface ProfileActionsProps {
  readonly profile: ProfileDto
}

export function ProfileActions({ profile }: ProfileActionsProps) {
  const earth = useEarth()
  const session = useSession()
  const gate = useClaimGate()
  const router = useRouter()
  const toast = useToast()
  const actions = useProfileActions(profile, 'profile')
  const [moreOpen, setMoreOpen] = useState(false)
  const [messaging, setMessaging] = useState(false)
  const { relationship } = profile
  const friend = friendActionFor(relationship)
  // Until the shell knows who is here (`me_get()`), no action is ready: a Human who taps in that
  // window would be sent to the claim sheet they already came through (spec §43 is for Visitors).
  const settling = session.status === 'loading'

  const message = async () => {
    if (!gate.requireHuman('profile')) return
    setMessaging(true)
    try {
      const conversation = await earth.conversations.directWith(profile.identity.humanId)
      router.push(conversationRoute(conversation.id))
    } catch {
      toast.show(profileCopy.couldntChange)
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
    <div className="flex flex-wrap items-center gap-2">
      {relationship.isBlocked ? (
        <span className="inline-flex min-h-touch-target items-center text-secondary text-text-secondary">
          {profileCopy.blocked}
        </span>
      ) : (
        <>
          <Button
            variant={friend === 'add' || friend === 'accept' ? 'primary' : 'secondary'}
            loading={actions.busy}
            disabled={settling}
            aria-pressed={friend === 'friends'}
            onClick={() => {
              if (friend === 'add') void actions.addFriend()
              else if (friend === 'accept') void actions.acceptFriend()
              else setMoreOpen(true)
            }}
          >
            {friendLabel}
          </Button>
          <Button
            variant="secondary"
            disabled={actions.busy || settling}
            aria-pressed={relationship.isFollowing}
            onClick={() => void actions.setFollow(!relationship.isFollowing)}
          >
            {relationship.isFollowing ? copy.profileActions.following : copy.profileActions.follow}
          </Button>
          {profile.canMessage ? (
            <Button
              variant="secondary"
              loading={messaging}
              disabled={settling}
              onClick={() => void message()}
            >
              {copy.profileActions.message}
            </Button>
          ) : null}
        </>
      )}
      <button
        type="button"
        onClick={() => setMoreOpen(true)}
        aria-label={copy.profileActions.more}
        aria-haspopup="dialog"
        className="flex size-touch-target items-center justify-center rounded-avatar text-text-secondary hover:bg-subtle-fill"
      >
        <Icon name="more" />
      </button>
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
    </div>
  )
}
