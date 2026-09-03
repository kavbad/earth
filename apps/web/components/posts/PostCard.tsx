'use client'

/**
 * A post anywhere it appears (spec §92; SCREEN 01–05, 07, 22): avatar, name, minimal metadata
 * (relative time · audience · context), generous text, large media, the place line, subdued
 * actions. No thick rounded card around the whole post; feed objects are separated by space.
 */
import type { PostId, PostViewDto } from '@earth/domain'
import { copy, formatHandle, relativeTime } from '@earth/ui'
import Link from 'next/link'

import { useCardImpression } from '../live/useCardImpression'
import { profileRoute } from '../profile/routes'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import { cx } from '../ui/cx'
import { PostActions } from './PostActions'
import { PostMedia } from './PostMedia'
import { postCopy } from './copy'
import type { PostActionContext } from './hooks/usePostActions'
import { postRoute } from './routes'

export const POST_CARD_VARIANTS = ['feed', 'detail', 'reply'] as const
export type PostCardVariant = (typeof POST_CARD_VARIANTS)[number]

export interface PostCardProps {
  readonly view: PostViewDto
  readonly context: PostActionContext
  readonly variant?: PostCardVariant
  /** Reported once when at least half the card is on screen (spec §97 `post_impression`). */
  readonly onSeen?: (() => void) | undefined
  /** Reported when the person opens the post (feed and reply variants link to the thread). */
  readonly onOpen?: (() => void) | undefined
  readonly onReply?: (() => void) | undefined
  readonly onHidden?: ((postId: PostId) => void) | undefined
  readonly className?: string | undefined
}

/** `2h · Friends` — relative time then the audience the author chose (spec §29). */
export function postMetaLine(view: PostViewDto, now: Date = new Date()): string {
  return [relativeTime(view.post.createdAt, now), copy.audiences[view.post.audience]].join(' · ')
}

/** `Dolores Park · Mission` — an explicit place tag, never a coordinate (spec §74). */
export function placeLine(view: PostViewDto): string | null {
  if (view.place === null) return null
  return view.place.areaName === null
    ? view.place.name
    : `${view.place.name} · ${view.place.areaName}`
}

export function PostCard({
  view,
  context,
  variant = 'feed',
  onSeen,
  onOpen,
  onReply,
  onHidden,
  className,
}: PostCardProps) {
  const ref = useCardImpression(onSeen ?? (() => undefined))
  const detail = variant === 'detail'
  const author = view.author
  const meta = postMetaLine(view)
  const place = placeLine(view)
  const href = postRoute(view.post.id)
  const text = view.post.text?.trim() ?? ''

  const body = (
    <>
      {text !== '' ? (
        <p
          className={cx(
            'whitespace-pre-wrap break-words text-text-primary',
            detail ? 'text-section font-regular' : 'text-body',
          )}
        >
          {text}
        </p>
      ) : null}
      <PostMedia
        media={view.media}
        authorName={author.displayName}
        className={text !== '' ? 'mt-3' : undefined}
      />
    </>
  )

  return (
    <article
      ref={onSeen === undefined ? undefined : ref}
      aria-label={`${author.displayName}: ${text === '' ? postCopy.photoAlt(author.displayName) : text.slice(0, 80)}`}
      className={cx(
        'flex gap-3 px-screen-margin',
        variant === 'reply' ? 'py-3' : 'py-4',
        className,
      )}
    >
      <Link
        href={profileRoute(author.handle)}
        aria-label={author.displayName}
        className="shrink-0 rounded-avatar"
      >
        <Avatar
          name={author.displayName}
          src={author.avatarUrl}
          size={variant === 'reply' ? 'small' : 'medium'}
          decorative
        />
      </Link>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <header className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0">
          <Link
            href={profileRoute(author.handle)}
            className="truncate text-body font-medium text-text-primary"
          >
            {author.displayName}
          </Link>
          {detail ? (
            <>
              <span className="truncate text-secondary text-text-secondary">
                {formatHandle(author.handle)}
              </span>
              <span className="inline-flex items-center gap-1 text-meta text-text-secondary">
                <Icon name="check" size="small" />
                {copy.human}
              </span>
            </>
          ) : null}
          <span className="text-secondary text-text-secondary">
            {detail ? meta : <Link href={href}>{meta}</Link>}
          </span>
        </header>
        {detail ? (
          <div>{body}</div>
        ) : (
          <Link
            href={href}
            {...(onOpen === undefined ? {} : { onClick: onOpen })}
            className="block"
            aria-label={postCopy.openPost}
          >
            {body}
          </Link>
        )}
        {place !== null ? (
          <p className="inline-flex items-center gap-1 text-secondary text-text-secondary">
            <Icon name="location" size="small" />
            <span className="truncate">{place}</span>
          </p>
        ) : null}
        <PostActions view={view} context={context} onReply={onReply} onHidden={onHidden} />
      </div>
    </article>
  )
}
