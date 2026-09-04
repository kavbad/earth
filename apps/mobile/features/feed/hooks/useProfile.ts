/**
 * A profile and the viewer's actions on it (SCREEN 22; spec §20–§21, §97): `profile_get` through
 * react-query, relationship RPCs folded back into the cache, block and report through the
 * safety namespace. Visitors meet the claim sheet on every action (spec §43).
 */
import type { SourceSurface } from '@earth/analytics'
import type { HumanId, ProfileDto, ReportReason } from '@earth/domain'
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'

import { profileCopy } from '../copy'
import { lightTap } from '@/lib/haptics'
import { bareHandle } from '../routes'
import { useFeedShell } from '../shell'
import { applyRelationshipChange } from '../state/profile'
import { useInvalidateFeed } from './useFeed'

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

export function useProfile(handle: string): ProfileController {
  const shell = useFeedShell()
  const enabled = shell.ready && bareHandle(handle).length > 0
  const query = useQuery({
    queryKey: profileQueryKey(handle),
    queryFn: () => shell.earth.social.profile(handle),
    enabled,
  })
  return {
    profile: query.data,
    loading: enabled && query.isPending,
    failed: query.isError && query.data === undefined,
    refreshFailed: query.isError && query.data !== undefined,
    refresh: () => {
      void query.refetch()
    },
  }
}

/**
 * Fold a relationship answer back into the cached profile (SCREEN 22). A `profile_get` that was
 * already in flight when the RPC landed carries the relationship as it stood *before* the action,
 * and react-query writes a late answer over a `setQueryData` — which put `Add Friend` back on a
 * profile whose request had been recorded, with nothing left to refetch it. The read in flight is
 * cancelled first so the newer answer stands (spec §20–§21).
 */
export async function commitProfile(
  queryClient: QueryClient,
  key: readonly unknown[],
  next: ProfileDto,
): Promise<void> {
  await queryClient.cancelQueries({ queryKey: key })
  queryClient.setQueryData(key, next)
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
  const shell = useFeedShell()
  const { earth, track, requireHuman, toast } = shell
  const queryClient = useQueryClient()
  const invalidateFeed = useInvalidateFeed()
  const [busy, setBusy] = useState(false)
  const target: HumanId = profile.identity.humanId
  const key = profileQueryKey(profile.identity.handle)

  const run = useCallback(
    async (work: () => Promise<ProfileDto | null>): Promise<boolean> => {
      if (!requireHuman('profile')) return false
      setBusy(true)
      try {
        const next = await work()
        if (next !== null) await commitProfile(queryClient, key, next)
        return true
      } catch {
        toast(profileCopy.couldntChange)
        return false
      } finally {
        setBusy(false)
      }
    },
    [key, queryClient, requireHuman, toast],
  )

  const addFriend = useCallback(async () => {
    lightTap()
    const ok = await run(async () =>
      applyRelationshipChange(profile, await earth.social.friendRequest(target)),
    )
    if (ok) track('friend_requested', { targetHumanId: target, source })
  }, [earth, profile, run, source, target, track])

  const acceptFriend = useCallback(async () => {
    lightTap()
    const ok = await run(async () =>
      applyRelationshipChange(profile, await earth.social.acceptFriend(target)),
    )
    if (ok) {
      track('friend_accepted', { requesterHumanId: target, source })
      void invalidateFeed()
    }
  }, [earth, invalidateFeed, profile, run, source, target, track])

  const removeFriend = useCallback(async () => {
    const ok = await run(async () =>
      applyRelationshipChange(profile, await earth.social.removeFriend(target)),
    )
    if (ok) void invalidateFeed()
  }, [earth, invalidateFeed, profile, run, target])

  const setFollow = useCallback(
    async (following: boolean) => {
      if (following) lightTap()
      const ok = await run(async () =>
        applyRelationshipChange(profile, await earth.social.setFollow(target, following)),
      )
      if (ok && following) track('follow_created', { targetHumanId: target, source })
    },
    [earth, profile, run, source, target, track],
  )

  const block = useCallback(async () => {
    const ok = await run(async () => {
      const change = await earth.social.block(target)
      return applyRelationshipChange(profile, change, change.isBlocked)
    })
    if (ok) {
      track('human_blocked', { targetHumanId: target, source })
      void invalidateFeed()
    }
  }, [earth, invalidateFeed, profile, run, source, target, track])

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
      if (ok) track('content_reported', { targetType: 'human', reason })
      return ok
    },
    [earth, run, target, track],
  )

  return { addFriend, acceptFriend, removeFriend, setFollow, block, unblock, report, busy }
}

/** The viewer's own profile (friend count for the zero-friends state, SCREEN 02). */
export function useMyProfile(): ProfileDto | undefined {
  const shell = useFeedShell()
  const handle = shell.identity?.handle ?? null
  const query = useQuery({
    queryKey: handle === null ? [PROFILE_QUERY_KEY, 'me'] : profileQueryKey(handle),
    queryFn: () => shell.earth.social.profile(handle ?? ''),
    enabled: shell.ready && shell.isHuman && handle !== null,
    staleTime: 5 * 60_000,
  })
  return query.data
}
