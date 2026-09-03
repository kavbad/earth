/**
 * What a person can do to a post from any surface (SCREEN 01–07; spec §81, §97): react, hide,
 * report, block the author, delete their own, share the link. Every action passes the claim gate
 * first (Visitors meet the sheet, spec §43), tracks its event, and folds into the caches.
 */
import type { SourceSurface } from '@earth/analytics'
import type { HumanId, PostId, PostViewDto, ReportReason, Scope } from '@earth/domain'
import { useQueryClient } from '@tanstack/react-query'
import * as Clipboard from 'expo-clipboard'
import { useCallback, useState } from 'react'
import { Platform, Share } from 'react-native'

import { postCopy } from '../copy'
import { lightTap } from '@/lib/haptics'
import { postShareUrl } from '../routes'
import { useFeedShell } from '../shell'
import {
  POST_REACTION,
  type ReactionState,
  reactionStateFor,
  toggledReaction,
} from '../state/reactions'
import { useInvalidateFeed } from './useFeed'
import { POST_QUERY_KEY, postQueryKey } from './usePost'

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

/** The system share sheet; the clipboard when the sheet is unavailable. */
async function shareUrl(url: string, onCopied: () => void): Promise<void> {
  try {
    await Share.share(Platform.OS === 'ios' ? { url } : { message: url })
  } catch {
    try {
      await Clipboard.setStringAsync(url)
      onCopied()
    } catch {
      // A dismissed share sheet or a clipboard without permission: nothing to report.
    }
  }
}

export function usePostActions(onHidden?: (postId: PostId) => void): PostActions {
  const shell = useFeedShell()
  const { earth, track, requireHuman, toast, webOrigin } = shell
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
        toast(postCopy.somethingWrong)
        return false
      } finally {
        setBusy(false)
      }
    },
    [toast],
  )

  const hide = useCallback<PostActions['hide']>(
    async (view, context) => {
      if (!requireHuman('post')) return false
      const ok = await run(() => earth.posts.hide(view.post.id))
      if (!ok) return false
      onHidden?.(view.post.id)
      track('post_hidden', {
        postId: view.post.id,
        scope: context.scope ?? 'world',
        audience: view.post.audience,
        position: context.position ?? 0,
      })
      void invalidateFeed()
      return true
    },
    [earth, invalidateFeed, onHidden, requireHuman, run, track],
  )

  const report = useCallback<PostActions['report']>(
    async (view, reason) => {
      if (!requireHuman('post')) return false
      const ok = await run(async () => {
        await earth.safety.report({
          targetType: 'post',
          targetId: view.post.id,
          reason,
          details: null,
        })
      })
      if (ok) track('content_reported', { targetType: 'post', reason })
      return ok
    },
    [earth, requireHuman, run, track],
  )

  const blockAuthor = useCallback<PostActions['blockAuthor']>(
    async (view, context) => {
      if (!requireHuman('post')) return false
      const target: HumanId = view.author.humanId
      const ok = await run(async () => {
        await earth.social.block(target)
      })
      if (!ok) return false
      track('human_blocked', { targetHumanId: target, source: context.source })
      onHidden?.(view.post.id)
      void invalidateFeed()
      void queryClient.invalidateQueries({ queryKey: [POST_QUERY_KEY] })
      return true
    },
    [earth, invalidateFeed, onHidden, queryClient, requireHuman, run, track],
  )

  const remove = useCallback<PostActions['remove']>(
    async (view) => {
      if (!requireHuman('post')) return false
      const ok = await run(() => earth.posts.delete(view.post.id))
      if (!ok) return false
      onHidden?.(view.post.id)
      void invalidateFeed()
      void queryClient.invalidateQueries({ queryKey: postQueryKey(view.post.id) })
      return true
    },
    [earth, invalidateFeed, onHidden, queryClient, requireHuman, run],
  )

  const share = useCallback<PostActions['share']>(
    async (view) => {
      await shareUrl(postShareUrl(webOrigin, view.post.id), () => toast(postCopy.linkCopied))
    },
    [toast, webOrigin],
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
  const shell = useFeedShell()
  const { earth, track, toast, isHuman, openClaim } = shell
  const [state, setState] = useState<ReactionState>(() => reactionStateFor(view))
  const [pending, setPending] = useState(false)

  const toggle = useCallback(() => {
    if (pending) return
    if (!isHuman) {
      openClaim('post')
      return
    }
    const next = toggledReaction(state)
    lightTap()
    setState(next)
    setPending(true)
    earth.posts
      .react({ postId: view.post.id, reaction: next.reacted ? POST_REACTION : null })
      .then(() => {
        if (next.reacted) {
          track('post_reacted', {
            postId: view.post.id,
            ...(context.scope === undefined ? {} : { scope: context.scope }),
            audience: view.post.audience,
          })
        }
      })
      .catch(() => {
        setState(state)
        toast(postCopy.somethingWrong)
      })
      .finally(() => setPending(false))
  }, [context.scope, earth, isHuman, openClaim, pending, state, toast, track, view])

  return { ...state, toggle, pending }
}
