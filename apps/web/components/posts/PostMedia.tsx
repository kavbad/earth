/* eslint-disable @next/next/no-img-element -- post media comes from signed storage URLs; no optimisation layer */
import type { PostMediaDto } from '@earth/domain'

import { cx } from '../ui/cx'
import { postCopy } from './copy'

export interface PostMediaProps {
  readonly media: readonly PostMediaDto[]
  readonly authorName: string
  readonly className?: string | undefined
}

/** Aspect ratio from the stored dimensions; a square when unknown so layout never jumps. */
export function mediaAspect(item: Pick<PostMediaDto, 'width' | 'height'>): string {
  return item.width > 0 && item.height > 0 ? `${item.width} / ${item.height}` : '1 / 1'
}

function MediaItem({ item, authorName }: { item: PostMediaDto; authorName: string }) {
  const style = { aspectRatio: mediaAspect(item) }
  if (item.mediaType === 'video') {
    return (
      <video
        src={item.url}
        controls
        playsInline
        preload="metadata"
        aria-label={postCopy.videoLabel(authorName)}
        className="block w-full rounded-medium bg-subtle-fill"
        style={style}
      />
    )
  }
  if (item.mediaType === 'audio') {
    return <audio src={item.url} controls preload="metadata" className="block w-full" />
  }
  return (
    <img
      src={item.url}
      alt={postCopy.photoAlt(authorName)}
      width={item.width > 0 ? item.width : undefined}
      height={item.height > 0 ? item.height : undefined}
      loading="lazy"
      className="block w-full rounded-medium bg-subtle-fill object-cover"
      style={style}
    />
  )
}

/**
 * Spec §92: media is large — one item runs the full content width at its own aspect ratio; more
 * items sit in a tight two-column grid. Never a thick card around the whole post.
 */
export function PostMedia({ media, authorName, className }: PostMediaProps) {
  if (media.length === 0) return null
  const single = media.length === 1
  return (
    <div
      className={cx(
        'overflow-hidden rounded-medium',
        single ? 'w-full' : 'grid grid-cols-2 gap-0.5',
        className,
      )}
    >
      {media.map((item) => (
        <MediaItem key={item.id} item={item} authorName={authorName} />
      ))}
    </div>
  )
}
