'use client'

/**
 * The subdued actions row (spec §92): React · Reply · Share · More as plain text, counts only
 * when there is something to count. Visitors meet the claim sheet on react/reply (spec §43).
 */
import type { PostViewDto } from '@earth/domain'
import { copy } from '@earth/ui'
import Link from 'next/link'
import { useState } from 'react'

import { useSession } from '../../lib/providers/SessionProvider'
import { useClaimGate } from '../shell/ClaimSheet'
import { Icon } from '../ui/Icon'
import { cx } from '../ui/cx'
import { PostMoreSheet } from './PostMoreSheet'
import { postCopy } from './copy'
import { type PostActionContext, usePostActions, useReaction } from './hooks/usePostActions'
import { postRoute } from './routes'

const ACTION_CLASS =
  'inline-flex min-h-touch-target items-center gap-1.5 rounded-small px-2 text-secondary text-text-secondary transition-colors duration-fast ease-standard hover:text-text-primary -ml-2 first:ml-0'

export interface PostActionsProps {
  readonly view: PostViewDto
  readonly context: PostActionContext
  /** Replies open the thread; on the detail screen the reply control focuses the composer. */
  readonly onReply?: (() => void) | undefined
  readonly onHidden?: ((postId: PostViewDto['post']['id']) => void) | undefined
  readonly className?: string | undefined
}

export function PostActions({ view, context, onReply, onHidden, className }: PostActionsProps) {
  const session = useSession()
  const gate = useClaimGate()
  const reaction = useReaction(view, context)
  const actions = usePostActions(onHidden)
  const [moreOpen, setMoreOpen] = useState(false)
  const isOwn = session.humanId !== null && session.humanId === view.author.humanId
  const replyLabel = view.replyCount > 0 ? `${copy.reply} ${view.replyCount}` : copy.reply
  const replyHref = postRoute(view.post.id)

  return (
    <div className={cx('flex items-center gap-1', className)}>
      <button
        type="button"
        onClick={reaction.toggle}
        aria-pressed={reaction.reacted}
        aria-label={`${reaction.reacted ? postCopy.reacted : postCopy.react}${reaction.count > 0 ? `, ${postCopy.reactionCount(reaction.count)}` : ''}`}
        className={cx(ACTION_CLASS, reaction.reacted && 'text-text-primary')}
      >
        <span aria-hidden="true">{reaction.reacted ? postCopy.reacted : postCopy.react}</span>
        {reaction.count > 0 ? <span aria-hidden="true">{reaction.count}</span> : null}
      </button>
      {onReply !== undefined ? (
        <button
          type="button"
          onClick={() => {
            if (gate.requireHuman('post')) onReply()
          }}
          className={ACTION_CLASS}
        >
          {replyLabel}
        </button>
      ) : (
        <Link
          href={replyHref}
          className={ACTION_CLASS}
          aria-label={`${copy.replies}${view.replyCount > 0 ? `, ${postCopy.replyCount(view.replyCount)}` : ''}`}
        >
          {replyLabel}
        </Link>
      )}
      <button type="button" onClick={() => void actions.share(view)} className={ACTION_CLASS}>
        {postCopy.share}
      </button>
      <button
        type="button"
        onClick={() => setMoreOpen(true)}
        aria-label={postCopy.more}
        aria-haspopup="dialog"
        className={cx(ACTION_CLASS, 'ml-auto')}
      >
        <Icon name="more" size="small" />
      </button>
      <PostMoreSheet
        open={moreOpen}
        view={view}
        isOwn={isOwn}
        busy={actions.busy}
        onReport={(reason) => actions.report(view, reason)}
        onHide={() => actions.hide(view, context)}
        onBlock={() => actions.blockAuthor(view, context)}
        onDelete={() => actions.remove(view)}
        onClose={() => setMoreOpen(false)}
      />
    </div>
  )
}
