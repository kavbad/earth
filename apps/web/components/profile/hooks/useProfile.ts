'use client'

/**
 * A profile and the viewer's actions on it (SCREEN 22; spec §20–§21, §97): `profile_get` through
 * react-query (seeded by the server render for public profiles), relationship RPCs folded back
 * into the cache, block and report through the safety namespace. Visitors meet the claim sheet
 * on every action (spec §43).
 */
import type { SourceSurface } from '@earth/analytics'
import type { HumanId, ProfileDto, ReportReason } from '@earth/domain'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'

import { useAnalytics } from '../../../lib/providers/AnalyticsProvider'
import { useEarth, useRuntime } from '../../../lib/providers/RuntimeProvider'
import { useSession } from '../../../lib/providers/SessionProvider'
import { useInvalidateFeed } from '../../feed/hooks/useFeed'
import { useClaimGate } from '../../shell/ClaimSheet'
import { useToast } from '../../ui/Toast'
import { profileCopy } from '../copy'
import { bareHandle } from '../routes'
import { applyRelationshipChange } from '../state/relationship'

export const PROFILE_QUERY_KEY = 'profile' as const

export function profileQueryKey(handle: string) {
  return [PROFILE_QUERY_KEY, bareHandle(handle)] as const
}

export interface ProfileController {
  readonly profile: ProfileDto | undefined
  readonly loading: boolean
  readonly failed: boolean
  readonly refreshFailed: boolean
  refresh(): void
}

export function useProfile(handle: string, initial?: ProfileDto | null): ProfileController {
  const earth = useEarth()
  const { runtime } = useRuntime()
  const session = useSession()
  const enabled = runtime !== null && session.status === 'ready'
  const query = useQuery({
    queryKey: profileQueryKey(handle),
    queryFn: () => earth.social.profile(handle),
    enabled,
    ...(initial === undefined || initial === null ? {} : { initialData: initial, staleTime: 0 }),
  })
  return {
    profile: query.data,
    // `enabled` is only ever false while the shell settles, which is still a load in progress:
    // the screen shows its skeleton rather than a blank column (spec §107).
    loading: query.isPending,
    failed: query.isError && query.data === undefined,
    refreshFailed: query.isError && query.data !== undefined,
    refresh: () => {
      void query.refetch()
    },
  }
}

export interface ProfileActions {
  addFriend(): Promise<void>
  acceptFriend(): Promise<void>
  removeFriend(): Promise<void>
  setFollow(following: boolean): Promise<void>
  block(): Promise<void>
  unblock(): Promise<void>
  report(reason: ReportReason): Promise<boolean>
  readonly busy: boolean
}

export function useProfileActions(profile: ProfileDto, source: SourceSurface): ProfileActions {
  const earth = useEarth()
  const gate = useClaimGate()
  const analytics = useAnalytics()
  const toast = useToast()
  const queryClient = useQueryClient()
  const invalidateFeed = useInvalidateFeed()
  const [busy, setBusy] = useState(false)
  const target: HumanId = profile.identity.humanId
  const key = profileQueryKey(profile.identity.handle)

  const run = useCallback(
    async (work: () => Promise<ProfileDto | null>): Promise<boolean> => {
      if (!gate.requireHuman('profile')) return false
      setBusy(true)
      try {
        const next = await work()
        if (next !== null) queryClient.setQueryData(key, next)
        return true
      } catch {
        toast.show(profileCopy.couldntChange)
        return false
      } finally {
        setBusy(false)
      }
    },
    [gate, key, queryClient, toast],
  )

  const addFriend = useCallback(async () => {
    const ok = await run(async () =>
      applyRelationshipChange(profile, await earth.social.friendRequest(target)),
    )
    if (ok) analytics.track('friend_requested', { targetHumanId: target, source })
  }, [analytics, earth, profile, run, source, target])

  const acceptFriend = useCallback(async () => {
    const ok = await run(async () =>
      applyRelationshipChange(profile, await earth.social.acceptFriend(target)),
    )
    if (ok) {
      analytics.track('friend_accepted', { requesterHumanId: target, source })
      void invalidateFeed()
    }
  }, [analytics, earth, invalidateFeed, profile, run, source, target])

  const removeFriend = useCallback(async () => {
    const ok = await run(async () =>
      applyRelationshipChange(profile, await earth.social.removeFriend(target)),
    )
    if (ok) void invalidateFeed()
  }, [earth, invalidateFeed, profile, run, target])

  const setFollow = useCallback(
    async (following: boolean) => {
      const ok = await run(async () =>
        applyRelationshipChange(profile, await earth.social.setFollow(target, following)),
      )
      if (ok && following) analytics.track('follow_created', { targetHumanId: target, source })
    },
    [analytics, earth, profile, run, source, target],
  )

  const block = useCallback(async () => {
    const ok = await run(async () => {
      const change = await earth.social.block(target)
      return applyRelationshipChange(profile, change, change.isBlocked)
    })
    if (ok) {
      analytics.track('human_blocked', { targetHumanId: target, source })
      void invalidateFeed()
    }
  }, [analytics, earth, invalidateFeed, profile, run, source, target])

  const unblock = useCallback(async () => {
    const ok = await run(async () => {
      const change = await earth.social.unblock(target)
      return applyRelationshipChange(profile, change, change.isBlocked)
    })
    if (ok) void invalidateFeed()
  }, [earth, invalidateFeed, profile, run, target])

  const report = useCallback(
    async (reason: ReportReason) => {
      const ok = await run(async () => {
        await earth.safety.report({ targetType: 'human', targetId: target, reason, details: null })
        return null
      })
      if (ok) analytics.track('content_reported', { targetType: 'human', reason })
      return ok
    },
    [analytics, earth, run, target],
  )

  return { addFriend, acceptFriend, removeFriend, setFollow, block, unblock, report, busy }
}

/** The viewer's own profile (friend count for the zero-friends state, SCREEN 02). */
export function useMyProfile(): ProfileDto | undefined {
  const earth = useEarth()
  const { runtime } = useRuntime()
  const session = useSession()
  const handle = session.identity?.handle ?? null
  const query = useQuery({
    queryKey: handle === null ? [PROFILE_QUERY_KEY, 'me'] : profileQueryKey(handle),
    queryFn: () => earth.social.profile(handle ?? ''),
    enabled: runtime !== null && session.roleKind === 'human' && handle !== null,
    staleTime: 5 * 60_000,
  })
  return query.data
}
