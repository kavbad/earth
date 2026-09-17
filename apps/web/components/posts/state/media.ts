/**
 * Composer media rules (SCREEN 06; spec §29–§30): which files are accepted, the post type a set
 * of attachments implies, and the one validation rule — text or media.
 */
import type { MediaType, PostType } from '@earth/domain'

/** `PostCreateInputSchema` caps media at ten items. */
export const POST_MEDIA_MAX = 10

/** `image/*` and `video/*` only; anything else is refused before an upload starts. */
export function postMediaType(contentType: string): Extract<MediaType, 'image' | 'video'> | null {
  const lower = contentType.trim().toLowerCase()
  if (lower.startsWith('image/')) return 'image'
  if (lower.startsWith('video/')) return 'video'
  return null
}

/** The accept list for the file input. */
export const POST_MEDIA_ACCEPT = 'image/*,video/*' as const

/** A video makes a video post; otherwise images make an image post; otherwise text. */
export function postTypeFor(media: ReadonlyArray<{ readonly mediaType: MediaType }>): PostType {
  if (media.some((item) => item.mediaType === 'video')) return 'video'
  if (media.some((item) => item.mediaType === 'image')) return 'image'
  return 'text'
}

/** SCREEN 06 validation: at least one of text or media. */
export function canPost(text: string, mediaCount: number): boolean {
  return text.trim().length > 0 || mediaCount > 0
}

/** Trimmed text, or `null` when the post is media-only. */
export function postText(text: string): string | null {
  const trimmed = text.trim()
  return trimmed.length === 0 ? null : trimmed
}
