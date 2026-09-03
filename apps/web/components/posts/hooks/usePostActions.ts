'use client'

/**
 * What a person can do to a post from any surface (SCREEN 01–07; spec §81, §97): react, hide,
 * report, block the author, delete their own, share the link. Every action passes the claim gate
 * first (Visitors meet the sheet, spec §43), tracks its event, and folds into the caches.
 */
import type { SourceSurface } from '@earth/analytics'
import {
  type HumanId,
  type PostId,
  type PostViewDto,
  type ReportReason,
  type Scope,
} from '@earth/domain'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'

import { useAnalytics } from '../../../lib/providers/AnalyticsProvider'
import { useEarth, usePublicEnv } from '../../../lib/providers/RuntimeProvider'
import { useSession } from '../../../lib/providers/SessionProvider'
import { useInvalidateFeed } from '../../feed/hooks/useFeed'
import { useClaimGate } from '../../shell/ClaimSheet'
import { useToast } from '../../ui/Toast'
import { postCopy } from '../copy'
import { postShareUrl } from '../routes'
import {
  POST_REACTION,
  type ReactionState,
  reactionStateFor,
  toggledReaction,
} from '../state/reactions'

export const POST_QUERY_KEY = 'post' as const

export function postQueryKey(postId: PostId): readonly [typeof POST_QUERY_KEY, PostId] {
  return [POST_QUERY_KEY, postId]
}

export interface PostActionContext {
  /** Where the action happened, for analytics. */
  readonly source: SourceSurface
  /** The radius being browsed when it happened (feeds only). */
  readonly scope?: Scope
  /** Position in the list (feeds only). */
  readonly position?: number
}

export interface PostActions {
  hide(view: PostViewDto, context: PostActionContext): Promise<boolean>
  report(view: PostViewDto, reason: ReportReason): Promise<boolean>
  blockAuthor(view: PostViewDto, context: PostActionContext): Promise<boolean>
  remove(view: PostViewDto): Promise<boolean>
  share(view: PostViewDto): Promise<void>
  readonly busy: boolean
}

export function usePostActions(onHidden?: (postId: PostId) => void): PostActions {
  const earth = useEarth()
  const env = usePublicEnv()
  const gate = useClaimGate()
  const analytics = useAnalytics()
  const toast = useToast()
  const queryClient = useQueryClient()
  const invalidateFeed = useInvalidateFeed()
  const [busy, setBusy] = useState(false)

  const run = useCallback(
    async (work: () => Promise<void>): Promise<boolean> => {
      setBusy(true)
      try {
        await work()
        return true
      } catch {
        toast.show(postCopy.somethingWrong)
        return false
      } finally {
        setBusy(false)
      }
    },
    [toast],
  )

  const hide = useCallback<PostActions['hide']>(
    async (view, context) => {
      if (!gate.requireHuman('post')) return false
      const ok = await run(() => earth.posts.hide(view.post.id))
      if (!ok) return false
      onHidden?.(view.post.id)
      analytics.track('post_hidden', {
        postId: view.post.id,
        scope: context.scope ?? 'world',
        audience: view.post.audience,
        position: context.position ?? 0,
      })
      void invalidateFeed()
      return true
    },
    [analytics, earth, gate, invalidateFeed, onHidden, run],
  )

  const report = useCallback<PostActions['report']>(
    async (view, reason) => {
      if (!gate.requireHuman('post')) return false
      const ok = await run(async () => {
        await earth.safety.report({
          targetType: 'post',
          targetId: view.post.id,
          reason,
          details: null,
        })
      })
      if (ok) analytics.track('content_reported', { targetType: 'post', reason })
      return ok
    },
    [analytics, earth, gate, run],
  )

  const blockAuthor = useCallback<PostActions['blockAuthor']>(
    async (view, context) => {
      if (!gate.requireHuman('post')) return false
      const target: HumanId = view.author.humanId
      const ok = await run(async () => {
        await earth.social.block(target)
      })
      if (!ok) return false
      analytics.track('human_blocked', { targetHumanId: target, source: context.source })
      onHidden?.(view.post.id)
      void invalidateFeed()
      void queryClient.invalidateQueries({ queryKey: [POST_QUERY_KEY] })
      return true
    },
    [analytics, earth, gate, invalidateFeed, onHidden, queryClient, run],
  )

  const remove = useCallback<PostActions['remove']>(
    async (view) => {
      if (!gate.requireHuman('post')) return false
      const ok = await run(() => earth.posts.delete(view.post.id))
      if (!ok) return false
      onHidden?.(view.post.id)
      void invalidateFeed()
      void queryClient.invalidateQueries({ queryKey: postQueryKey(view.post.id) })
      return true
    },
    [earth, gate, invalidateFeed, onHidden, queryClient, run],
  )

  const share = useCallback<PostActions['share']>(
    async (view) => {
      const origin =
        env?.WEB_ORIGIN ?? (typeof window === 'undefined' ? '' : window.location.origin)
      const url = postShareUrl(origin, view.post.id)
      try {
        if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
          await navigator.share({ url })
          return
        }
        await navigator.clipboard.writeText(url)
        toast.show(postCopy.linkCopied)
      } catch {
        // A dismissed share sheet or a clipboard without permission: nothing to report.
      }
    },
    [env, toast],
  )

  return { hide, report, blockAuthor, remove, share, busy }
}

export interface ReactionControl extends ReactionState {
  toggle(): void
  readonly pending: boolean
}

/**
 * The viewer's reaction on one post, optimistic: the count moves at once and rolls back when the
 * RPC fails. Visitors meet the claim sheet instead (spec §43).
 */
export function useReaction(view: PostViewDto, context: PostActionContext): ReactionControl {
  const earth = useEarth()
  const gate = useClaimGate()
  const analytics = useAnalytics()
  const toast = useToast()
  const session = useSession()
  const [state, setState] = useState<ReactionState>(() => reactionStateFor(view))
  const [pending, setPending] = useState(false)

  const toggle = useCallback(() => {
    if (pending) return
    if (session.roleKind !== 'human') {
      gate.open('post')
      return
    }
    const next = toggledReaction(state)
    setState(next)
    setPending(true)
    earth.posts
      .react({ postId: view.post.id, reaction: next.reacted ? POST_REACTION : null })
      .then(() => {
        if (next.reacted) {
          analytics.track('post_reacted', {
            postId: view.post.id,
            ...(context.scope === undefined ? {} : { scope: context.scope }),
            audience: view.post.audience,
          })
        }
      })
      .catch(() => {
        setState(state)
        toast.show(postCopy.somethingWrong)
      })
      .finally(() => setPending(false))
  }, [analytics, context.scope, earth, gate, pending, session.roleKind, state, toast, view])

  return { ...state, toggle, pending }
}
