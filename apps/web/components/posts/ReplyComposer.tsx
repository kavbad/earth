'use client'

/**
 * The inline reply composer at the foot of a post (SCREEN 07): one line, audience inherited from
 * the root (never wider, spec §72), a link to the full composer for photos. Visitors see the row
 * and meet the claim sheet when they touch it (spec §43).
 */
import type { PostDetailDto } from '@earth/domain'
import { copy } from '@earth/ui'
import Link from 'next/link'
import { type KeyboardEvent, forwardRef, useState } from 'react'

import { useSession } from '../../lib/providers/SessionProvider'
import { useClaimGate } from '../shell/ClaimSheet'
import { Icon } from '../ui/Icon'
import { Spinner } from '../ui/Spinner'
import { useToast } from '../ui/Toast'
import { cx } from '../ui/cx'
import { postCopy } from './copy'
import { useCreatePost } from './hooks/usePost'
import { composeRoute } from './routes'
import { postText } from './state/media'

export interface ReplyComposerProps {
  readonly parent: PostDetailDto
  readonly onPosted?: (() => void) | undefined
}

const ICON_BUTTON =
  'flex size-touch-target shrink-0 items-center justify-center rounded-avatar text-text-primary transition-colors duration-fast ease-standard hover:bg-subtle-fill disabled:opacity-40'

export const ReplyComposer = forwardRef<HTMLTextAreaElement, ReplyComposerProps>(
  function ReplyComposer({ parent, onPosted }, ref) {
    const session = useSession()
    const gate = useClaimGate()
    const toast = useToast()
    const create = useCreatePost()
    const [text, setText] = useState('')
    const isHuman = session.roleKind === 'human'
    const audience = parent.post.audience
    const closed = parent.post.replyPolicy === 'none'

    const submit = async () => {
      const body = postText(text)
      if (body === null || create.pending) return
      if (!gate.requireHuman('post')) return
      try {
        await create.create({
          type: 'text',
          text: body,
          audience,
          placeId: null,
          media: [],
          parentPostId: parent.post.id,
        })
        setText('')
        onPosted?.()
      } catch {
        toast.show(postCopy.couldntPost)
      }
    }

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault()
        void submit()
      }
    }

    if (closed) {
      return (
        <p className="px-screen-margin py-3 text-secondary text-text-secondary">
          {postCopy.repliesClosed}
        </p>
      )
    }

    return (
      <div className="sticky bottom-0 z-sticky bg-background pb-[env(safe-area-inset-bottom)] hairline-t">
        <div className="flex items-center justify-between gap-2 px-screen-margin pt-2 text-meta text-text-secondary">
          <span>{postCopy.audienceCapped(copy.audiences[audience])}</span>
          {isHuman ? (
            <Link
              href={composeRoute({ replyTo: parent.post.id })}
              className="text-meta text-text-secondary"
            >
              {postCopy.addPhotoVideo}
            </Link>
          ) : null}
        </div>
        <div className="flex items-end gap-1 px-2 py-2">
          <label className="flex min-w-0 flex-1 items-center">
            <span className="sr-only">{copy.reply}</span>
            <textarea
              ref={ref}
              rows={1}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={onKeyDown}
              onFocus={() => {
                if (!isHuman) gate.open('post')
              }}
              placeholder={postCopy.replyPlaceholder}
              enterKeyHint="send"
              className="max-h-[136px] min-h-10 w-full resize-none rounded-medium bg-subtle-fill px-4 py-2 text-body text-text-primary placeholder:text-text-secondary"
            />
          </label>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={create.pending || postText(text) === null}
            aria-label={copy.reply}
            className={cx(ICON_BUTTON, 'bg-text-primary text-background hover:bg-text-primary')}
          >
            {create.pending ? (
              <Spinner className="border-(color:--earth-color-background)/40 border-t-(color:--earth-color-background)" />
            ) : (
              <Icon name="send" />
            )}
          </button>
        </div>
      </div>
    )
  },
)
