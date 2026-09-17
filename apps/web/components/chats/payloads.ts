/**
 * Message payload shapes (spec §27 `payload JSONB`). The database keeps `payload` an opaque
 * object; the web client is the first writer of these shapes, so they are pinned here with zod
 * and parsed leniently on read (an unknown shape renders as its type's preview, never crashes).
 *
 * - image / video / audio / file: the `media_objects` row `media.upload` registered.
 * - poll: question + options; votes are reactions `poll:<optionId>` (spec §28 unique per
 *   message/human/reaction), so no extra table is needed in V1.
 * - place: a public place (spec §38), never a device coordinate.
 * - system: `{ kind, actorHumanId }` written by the database (0275).
 */
import { MediaBucketSchema, type MediaObjectDto } from '@earth/api'
import {
  type JsonObject,
  type MessageType,
  type PlaceDto,
  type SearchPlaceDto,
} from '@earth/domain'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export const MediaPayloadSchema = z.object({
  mediaObjectId: z.uuid(),
  bucket: MediaBucketSchema,
  storageKey: z.string().min(1),
  contentType: z.string().min(1),
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  durationMs: z.number().int().min(0).nullable().default(null),
  byteSize: z.number().int().min(0).nullable().default(null),
  /** Original file name (files only). */
  name: z.string().nullable().default(null),
})
export type MediaPayload = z.infer<typeof MediaPayloadSchema>

export interface MediaPayloadExtras {
  readonly width?: number | null
  readonly height?: number | null
  readonly durationMs?: number | null
  readonly byteSize?: number | null
  readonly name?: string | null
}

export function mediaPayload(media: MediaObjectDto, extras: MediaPayloadExtras = {}): JsonObject {
  return {
    mediaObjectId: media.id,
    bucket: media.bucket,
    storageKey: media.storageKey,
    contentType: media.contentType,
    width: extras.width ?? null,
    height: extras.height ?? null,
    durationMs: extras.durationMs ?? null,
    byteSize: extras.byteSize ?? null,
    name: extras.name ?? null,
  }
}

export function parseMediaPayload(payload: JsonObject): MediaPayload | null {
  const parsed = MediaPayloadSchema.safeParse(payload)
  return parsed.success ? parsed.data : null
}

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

export const POLL_OPTIONS_MIN = 2
export const POLL_OPTIONS_MAX = 6
export const POLL_TEXT_MAX = 120
/** Reaction prefix of a vote: `poll:a`, `poll:b`, ... (reactions are at most 16 characters). */
export const POLL_VOTE_PREFIX = 'poll:' as const
const POLL_OPTION_IDS = ['a', 'b', 'c', 'd', 'e', 'f'] as const

export const PollOptionSchema = z.object({
  id: z.string().min(1).max(8),
  text: z.string().trim().min(1).max(POLL_TEXT_MAX),
})
export type PollOption = z.infer<typeof PollOptionSchema>

export const PollPayloadSchema = z.object({
  question: z.string().trim().min(1).max(POLL_TEXT_MAX),
  options: z.array(PollOptionSchema).min(POLL_OPTIONS_MIN).max(POLL_OPTIONS_MAX),
  multiple: z.boolean().default(false),
})
export type PollPayload = z.infer<typeof PollPayloadSchema>

export function pollPayload(question: string, options: readonly string[]): JsonObject {
  return {
    question: question.trim(),
    options: options.map((text, index) => ({ id: POLL_OPTION_IDS[index] ?? String(index), text })),
    multiple: false,
  }
}

export function parsePollPayload(payload: JsonObject): PollPayload | null {
  const parsed = PollPayloadSchema.safeParse(payload)
  return parsed.success ? parsed.data : null
}

export function pollVoteReaction(optionId: string): string {
  return `${POLL_VOTE_PREFIX}${optionId}`
}

export function isPollVoteReaction(reaction: string): boolean {
  return reaction.startsWith(POLL_VOTE_PREFIX)
}

export function pollOptionIdOf(reaction: string): string | null {
  return isPollVoteReaction(reaction) ? reaction.slice(POLL_VOTE_PREFIX.length) : null
}

// ---------------------------------------------------------------------------
// Place
// ---------------------------------------------------------------------------

export const PlacePayloadSchema = z.object({
  placeId: z.uuid(),
  name: z.string().min(1),
  areaName: z.string().nullable().default(null),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  category: z.string().nullable().default(null),
})
export type PlacePayload = z.infer<typeof PlacePayloadSchema>

export function placePayload(place: PlaceDto | SearchPlaceDto): JsonObject {
  const placeId = 'placeId' in place ? place.placeId : place.id
  return {
    placeId,
    name: place.name,
    areaName: place.areaName,
    lat: place.lat,
    lng: place.lng,
    category: place.category,
  }
}

export function parsePlacePayload(payload: JsonObject): PlacePayload | null {
  const parsed = PlacePayloadSchema.safeParse(payload)
  return parsed.success ? parsed.data : null
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export const SystemPayloadSchema = z.object({
  kind: z.string().optional(),
  actorHumanId: z.uuid().optional(),
})
export type SystemPayload = z.infer<typeof SystemPayloadSchema>

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

/** Mirror of `earth.message_preview(type, text)` (0270): the row line for non-text messages. */
export const MESSAGE_TYPE_PREVIEW: Readonly<Record<MessageType, string>> = {
  text: '',
  image: 'Photo',
  video: 'Video',
  audio: 'Voice message',
  file: 'File',
  poll: 'Poll',
  system: '',
  place: 'Place',
  plan: 'Plan',
}

export const PREVIEW_MAX = 120

export function messagePreviewText(type: MessageType, text: string | null): string {
  const clean = (text ?? '').trim().replace(/\s+/g, ' ')
  if (clean.length > 0) return clean.slice(0, PREVIEW_MAX)
  return MESSAGE_TYPE_PREVIEW[type]
}

/** Which media type an uploaded file becomes (spec §27 message types). */
export function messageTypeForFile(
  contentType: string,
): Extract<MessageType, 'image' | 'video' | 'file'> {
  if (contentType.startsWith('image/')) return 'image'
  if (contentType.startsWith('video/')) return 'video'
  return 'file'
}

const CONTENT_TYPE_REGEX = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/
export const FALLBACK_CONTENT_TYPE = 'application/octet-stream'

/** A content type `media.upload` accepts; browsers report `''` for unknown files. */
export function normalizeContentType(contentType: string): string {
  const lower = contentType.trim().toLowerCase()
  return CONTENT_TYPE_REGEX.test(lower) ? lower : FALLBACK_CONTENT_TYPE
}

/** `1.2 MB` · `840 KB` · `12 B`. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(Math.round((bytes / (1024 * 1024)) * 10) / 10).toFixed(1)} MB`
}

/** `0:42` · `12:05`. */
export function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return ''
  const totalSeconds = Math.round(durationMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}
