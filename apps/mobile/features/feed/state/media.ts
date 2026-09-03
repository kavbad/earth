/**
 * Composer media rules (SCREEN 06; spec §29–§30): which picked assets are accepted, the
 * provenance a source implies (`earth_capture` for the in-app camera, `uploaded` for the
 * library), the post type a set of attachments implies, the one validation rule — text or media —
 * and the pending-attachment reducer the upload queue runs on. Pure; the device is touched by
 * the hooks.
 */
import type { PostMediaArgs } from '@earth/api'
import type { MediaProvenance, MediaType, PostType } from '@earth/domain'

/** `PostCreateInputSchema` caps media at ten items. */
export const POST_MEDIA_MAX = 10

export type PostMediaKind = Extract<MediaType, 'image' | 'video'>

/** `image/*` and `video/*` only; anything else is refused before an upload starts. */
export function postMediaType(contentType: string): PostMediaKind | null {
  const lower = contentType.trim().toLowerCase()
  if (lower.startsWith('image/')) return 'image'
  if (lower.startsWith('video/')) return 'video'
  return null
}

/** Where an attachment came from (spec §30 provenance). */
export const MEDIA_SOURCES = ['camera', 'library'] as const
export type MediaSource = (typeof MEDIA_SOURCES)[number]

/** The in-app camera is an Earth capture; the library is an upload. */
export function provenanceFor(source: MediaSource): MediaProvenance {
  return source === 'camera' ? 'earth_capture' : 'uploaded'
}

/** The slice of an `expo-image-picker` asset the composer reads. */
export interface PickedAssetLike {
  readonly uri: string
  readonly width: number
  readonly height: number
  readonly mimeType?: string | undefined
  readonly type?: string | null | undefined
  readonly duration?: number | null | undefined
  readonly fileSize?: number | undefined
}

/** A picker asset's content type: its `mimeType`, else derived from its kind and extension. */
export function contentTypeForAsset(asset: PickedAssetLike): string {
  if (asset.mimeType !== undefined && asset.mimeType.includes('/'))
    return asset.mimeType.toLowerCase()
  const extension = asset.uri.split('?')[0]?.split('.').pop()?.toLowerCase() ?? ''
  if (asset.type === 'video') {
    return extension === 'mov' ? 'video/quicktime' : 'video/mp4'
  }
  switch (extension) {
    case 'png':
      return 'image/png'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'heic':
      return 'image/heic'
    default:
      return 'image/jpeg'
  }
}

function positiveOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

export interface PickedMedia {
  readonly uri: string
  readonly contentType: string
  readonly mediaType: PostMediaKind
  readonly width: number
  readonly height: number
  readonly durationMs: number | null
  readonly byteSize: number | null
  readonly provenance: MediaProvenance
}

/** A picker asset the composer can attach, or `null` when it is not a photo or video. */
export function pickedMediaFromAsset(
  asset: PickedAssetLike,
  source: MediaSource,
): PickedMedia | null {
  const contentType = contentTypeForAsset(asset)
  const mediaType = postMediaType(contentType)
  if (mediaType === null) return null
  return {
    uri: asset.uri,
    contentType,
    mediaType,
    width: positiveOrNull(asset.width) ?? 0,
    height: positiveOrNull(asset.height) ?? 0,
    durationMs: positiveOrNull(asset.duration),
    byteSize: positiveOrNull(asset.fileSize),
    provenance: provenanceFor(source),
  }
}

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

// ---------------------------------------------------------------------------
// Pending attachments (the upload queue)
// ---------------------------------------------------------------------------

export const PENDING_MEDIA_STATUSES = ['uploading', 'ready', 'failed'] as const
export type PendingMediaStatus = (typeof PENDING_MEDIA_STATUSES)[number]

export interface PendingMedia {
  readonly key: string
  readonly picked: PickedMedia
  readonly status: PendingMediaStatus
  /** What `post_create` receives once the upload registered a media object. */
  readonly args: PostMediaArgs | null
}

export interface PendingMediaState {
  readonly items: readonly PendingMedia[]
  /** Assets refused because there were too many or they were not photos/videos. */
  readonly rejected: number
}

export const EMPTY_PENDING_MEDIA: PendingMediaState = { items: [], rejected: 0 }

export type PendingMediaAction =
  | { readonly type: 'add'; readonly items: readonly PendingMedia[]; readonly rejected: number }
  | { readonly type: 'uploaded'; readonly key: string; readonly args: PostMediaArgs }
  | { readonly type: 'failed'; readonly key: string }
  | { readonly type: 'remove'; readonly key: string }
  | { readonly type: 'clear' }

/** How many more attachments fit (spec caps at ten). */
export function mediaRoom(state: PendingMediaState): number {
  return Math.max(0, POST_MEDIA_MAX - state.items.length)
}

export function pendingMediaReducer(
  state: PendingMediaState,
  action: PendingMediaAction,
): PendingMediaState {
  switch (action.type) {
    case 'add': {
      const room = mediaRoom(state)
      const taking = action.items.slice(0, room)
      const refused = action.rejected + (action.items.length - taking.length)
      return { items: [...state.items, ...taking], rejected: state.rejected + refused }
    }
    case 'uploaded':
      return {
        ...state,
        items: state.items.map((item) =>
          item.key === action.key ? { ...item, status: 'ready', args: action.args } : item,
        ),
      }
    case 'failed':
      return {
        ...state,
        items: state.items.map((item) =>
          item.key === action.key ? { ...item, status: 'failed', args: null } : item,
        ),
      }
    case 'remove':
      return { ...state, items: state.items.filter((item) => item.key !== action.key) }
    case 'clear':
      return EMPTY_PENDING_MEDIA
    default: {
      const exhaustive: never = action
      throw new Error(`Unknown media action: ${String(exhaustive)}`)
    }
  }
}

/** The attachments ready for `post_create`, in order. */
export function readyMedia(state: PendingMediaState): readonly PostMediaArgs[] {
  return state.items.flatMap((item) => (item.args === null ? [] : [item.args]))
}

export function isUploading(state: PendingMediaState): boolean {
  return state.items.some((item) => item.status === 'uploading')
}
