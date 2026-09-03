'use client'

/**
 * SCREEN 22 — profile hierarchy: avatar, display name, handle, city if shared, mutual friends,
 * actions; then "Now" posts. Follower numbers are visually secondary. Visitors see public
 * profiles and meet the claim sheet on every action (spec §43).
 */
import type { ProfileDto, ViewerRelation } from '@earth/domain'
import { copy, formatHandle, mutualLine } from '@earth/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'

import { webCopy } from '../../lib/copy'
import { useAnalytics } from '../../lib/providers/AnalyticsProvider'
import { ROUTES, asRoute } from '../../lib/routes'
import { LoadingState } from '../shell/LoadingState'
import { PageContainer } from '../shell/PageContainer'
import { ScreenHeader } from '../shell/ScreenHeader'
import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Icon } from '../ui/Icon'
import { Skeleton } from '../ui/Skeleton'
import { ProfileActions } from './ProfileActions'
import { ProfilePosts } from './ProfilePosts'
import { profileCopy } from './copy'
import { useProfile } from './hooks/useProfile'
import { profileActionsAvailable } from './state/relationship'

export interface ProfileScreenProps {
  readonly handle: string
  /** The server-rendered public profile; `null` when the server could not read it. */
  readonly initial?: ProfileDto | null
}

export function viewerRelationFor(profile: ProfileDto): ViewerRelation {
  if (profile.relationship.isSelf) return 'self'
  if (profile.relationship.isFriend) return 'friend'
  if (profile.sharedGroupCount > 0) return 'shared_group'
  return 'other'
}

function ProfileSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-4 px-screen-margin py-6">
      <Skeleton className="size-24 rounded-avatar" />
      <Skeleton className="h-6 w-1/2" />
      <Skeleton className="h-4 w-1/3" />
    </div>
  )
}

export function ProfileScreen({ handle, initial }: ProfileScreenProps) {
  const router = useRouter()
  const analytics = useAnalytics()
  const { profile, loading, failed, refreshFailed, refresh } = useProfile(handle, initial)

  const viewed = useRef<string | null>(null)
  useEffect(() => {
    if (profile === undefined || viewed.current === profile.identity.humanId) return
    viewed.current = profile.identity.humanId
    analytics.track('profile_viewed', {
      profileHumanId: profile.identity.humanId,
      relation: viewerRelationFor(profile),
      source: 'profile',
    })
  }, [analytics, profile])

  const back = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) router.back()
    else router.push(asRoute(ROUTES.home))
  }

  const identity = profile?.identity
  return (
    <>
      <ScreenHeader
        {...(identity === undefined ? {} : { title: identity.displayName })}
        leading={
          <button
            type="button"
            onClick={back}
            aria-label={webCopy.back}
            className="flex size-touch-target items-center justify-center rounded-avatar text-text-primary hover:bg-subtle-fill"
          >
            <Icon name="back" />
          </button>
        }
      />
      <PageContainer>
        {profile === undefined ? (
          failed ? (
            // Spec §107: offline this reads "Waiting for connection", not "profile unavailable".
            <LoadingState>
              <EmptyState
                title={profileCopy.profileUnavailable}
                action={
                  <Button variant="quiet" onClick={refresh}>
                    {webCopy.retry}
                  </Button>
                }
              />
            </LoadingState>
          ) : loading ? (
            <LoadingState>
              <ProfileSkeleton />
            </LoadingState>
          ) : null
        ) : (
          <div className="fade-in flex flex-col">
            {refreshFailed ? (
              <p role="status" className="px-screen-margin py-2 text-secondary text-text-secondary">
                {copy.couldntRefresh}
              </p>
            ) : null}
            <section className="flex flex-col gap-4 px-screen-margin py-6">
              <Avatar
                name={profile.identity.displayName}
                src={profile.identity.avatarUrl}
                size="profile"
              />
              <div className="flex flex-col gap-1">
                <h2 className="text-title">{profile.identity.displayName}</h2>
                <p className="flex flex-wrap items-center gap-x-2 text-secondary text-text-secondary">
                  <span>{formatHandle(profile.identity.handle)}</span>
                  <span className="inline-flex items-center gap-1 text-meta">
                    <Icon name="check" size="small" />
                    {copy.human}
                  </span>
                </p>
                {profile.identity.cityName !== null ? (
                  <p className="inline-flex items-center gap-1 text-secondary text-text-secondary">
                    <Icon name="location" size="small" />
                    {profile.identity.cityName}
                  </p>
                ) : null}
                {!profile.relationship.isSelf &&
                (profile.mutualFriendCount > 0 || profile.sharedGroupCount > 0) ? (
                  <p className="text-secondary text-text-secondary">
                    {[
                      mutualLine(profile.mutualFriendCount, null),
                      profile.sharedGroupCount > 0
                        ? profileCopy.sharedGroups(profile.sharedGroupCount)
                        : '',
                    ]
                      .filter((part) => part.length > 0)
                      .join(' · ')}
                  </p>
                ) : null}
                {profile.identity.bio !== null && profile.identity.bio.trim() !== '' ? (
                  <p className="mt-2 whitespace-pre-wrap text-body text-text-primary">
                    {profile.identity.bio}
                  </p>
                ) : null}
              </div>
              {profile.relationship.isSelf ? (
                <Link href={asRoute(ROUTES.you)} className="text-secondary text-text-secondary">
                  {profileCopy.editProfile}
                </Link>
              ) : profileActionsAvailable(profile) || profile.relationship.isBlocked ? (
                <ProfileActions profile={profile} />
              ) : null}
              <p className="text-meta text-text-secondary">
                {[
                  profileCopy.friendsCount(profile.counts.friends),
                  profileCopy.followersCount(profile.counts.followers),
                  profileCopy.followingCount(profile.counts.following),
                ].join(' · ')}
              </p>
            </section>
            <ProfilePosts profile={profile} />
          </div>
        )}
      </PageContainer>
    </>
  )
}
