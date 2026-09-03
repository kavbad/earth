/**
 * Row contracts for `feed_candidates` (DB_API §4) and `live_candidates` (DB_API §3), and their
 * conversion into `FeedCardDto` / `LiveCardDto` for the viewer.
 *
 * DB_API §4 says a candidate row is the `FeedCandidate` features "plus rendering payloads
 * (`PostDto` / live card fields)". The server tier fixes the payload keys as:
 *
 * - `post`: a `PostViewDto` (required when `kind = 'post'`);
 * - `live`: a `LiveRoomRow` (required when `kind = 'live'`) — the same shape `live_candidates`
 *   returns per room: participants with their `relationToViewer`, context title, area name,
 *   `startedAt`.
 *
 * The RPCs may return the rows bare (`[...]`) or wrapped as `{ candidates: [...], areaName }` so
 * the browsed area's name can travel with the page; both forms are accepted.
 */
import {
  type FeedCandidate,
  FeedCandidateSchema,
  type FeedPostCardDto,
  IsoDateTimeSchema,
  type LiveCardDto,
  LiveCardDtoSchema,
  MediaStateSchema,
  type NamingParticipant,
  NonNegativeIntSchema,
  NullableUrlSchema,
  ParticipantStatusSchema,
  PostViewDtoSchema,
  RoomContextTypeSchema,
  RoomIdSchema,
  RoomVisibilitySchema,
  ViewerRelationSchema,
  liveCardTitle,
  orderParticipantsForViewer,
  pickNamedParticipants,
  roomTitleKindFor,
} from '@earth/domain'
import { z } from 'zod'

import { parseOutput } from '../http'

// ---------------------------------------------------------------------------
// Live rows
// ---------------------------------------------------------------------------

/** One participant of a discoverable room, as `live_candidates` / the live payload returns it. */
export const LiveParticipantRowSchema = z.object({
  id: z.uuid(),
  displayName: z.string().trim().min(1),
  avatarUrl: NullableUrlSchema.default(null),
  isGuest: z.boolean().default(false),
  mediaState: MediaStateSchema,
  status: ParticipantStatusSchema.default('active'),
  /** `null` for visitors/guests who have no social graph. */
  relationToViewer: ViewerRelationSchema.nullable().default(null),
  joinedAt: IsoDateTimeSchema,
})
export type LiveParticipantRow = z.infer<typeof LiveParticipantRowSchema>

export const LiveRoomRowSchema = z.object({
  roomId: RoomIdSchema,
  contextType: RoomContextTypeSchema,
  /** "Weekend Crew" for group rooms. */
  contextTitle: z.string().nullable().default(null),
  /** Optional activity label ("Cooking dinner"). */
  title: z.string().nullable().default(null),
  visibility: RoomVisibilitySchema,
  startedAt: IsoDateTimeSchema,
  areaName: z.string().nullable().default(null),
  participants: z.array(LiveParticipantRowSchema).default([]),
  /** Active participant count when the RPC provides it; otherwise derived from `participants`. */
  participantCount: NonNegativeIntSchema.optional(),
})
export type LiveRoomRow = z.infer<typeof LiveRoomRowSchema>

// ---------------------------------------------------------------------------
// Feed candidate rows
// ---------------------------------------------------------------------------

export const FeedCandidateRowSchema = z
  .object({
    ...FeedCandidateSchema.shape,
    post: PostViewDtoSchema.nullish(),
    live: LiveRoomRowSchema.nullish(),
  })
  .superRefine((row, ctx) => {
    // The candidate `id` is the keyset cursor key and the card id (ARCHITECTURE §9): the payload
    // must be the very post / room it ranks, or pages would repeat and skip cards silently.
    if (row.kind === 'post') {
      if (row.post === null || row.post === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['post'],
          message: 'post candidates carry a post payload',
        })
      } else if (row.post.post.id !== row.id) {
        ctx.addIssue({
          code: 'custom',
          path: ['post', 'post', 'id'],
          message: 'post payload id must equal the candidate id',
        })
      }
    }
    if (row.kind === 'live') {
      if (row.live === null || row.live === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['live'],
          message: 'live candidates carry a live payload',
        })
      } else if (row.live.roomId !== row.id) {
        ctx.addIssue({
          code: 'custom',
          path: ['live', 'roomId'],
          message: 'live payload roomId must equal the candidate id',
        })
      }
    }
  })
export type FeedCandidateRow = z.infer<typeof FeedCandidateRowSchema>

function wrapped<T extends z.ZodType>(row: T) {
  return z.union([
    z.array(row).transform((rows) => ({ rows, areaName: null as string | null })),
    z
      .object({ candidates: z.array(row), areaName: z.string().nullable().optional() })
      .transform((result) => ({ rows: result.candidates, areaName: result.areaName ?? null })),
    z.null().transform(() => ({ rows: [] as z.infer<T>[], areaName: null as string | null })),
  ])
}

export const FeedCandidatesResultSchema = wrapped(FeedCandidateRowSchema)
export type FeedCandidatesResult = z.infer<typeof FeedCandidatesResultSchema>

export const LiveCandidatesResultSchema = wrapped(LiveRoomRowSchema)
export type LiveCandidatesResult = z.infer<typeof LiveCandidatesResultSchema>

/** The ranking features of a row (rendering payloads stripped). */
export function candidateOf(row: FeedCandidateRow): FeedCandidate {
  return FeedCandidateSchema.parse(row)
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

interface NamedLiveParticipant extends NamingParticipant {
  readonly avatarUrl: string | null
}

export function namingParticipantsOf(row: LiveRoomRow): NamedLiveParticipant[] {
  return row.participants.map((p) => ({
    id: p.id,
    displayName: p.displayName,
    isGuest: p.isGuest,
    mediaState: p.mediaState,
    status: p.status,
    relation: p.relationToViewer,
    joinedAt: p.joinedAt,
    avatarUrl: p.avatarUrl,
  }))
}

/** Participants that count and may be named: active publishers, viewer excluded (spec §60 privacy). */
export function publishingParticipantsOf(row: LiveRoomRow): NamedLiveParticipant[] {
  return orderParticipantsForViewer(namingParticipantsOf(row))
}

/** `LiveCardDto` for the viewer: title, names and avatars follow spec §60 ordering. */
export function liveCardFrom(row: LiveRoomRow): LiveCardDto {
  const participants = namingParticipantsOf(row)
  const ordered = orderParticipantsForViewer(participants)
  const named = pickNamedParticipants(ordered)
  const title = liveCardTitle({
    kind: roomTitleKindFor(row.contextType),
    contextTitle: row.contextTitle,
    participants,
    activityTitle: row.title,
  })
  return parseOutput(
    LiveCardDtoSchema,
    {
      kind: 'live',
      id: row.roomId,
      roomId: row.roomId,
      title,
      participantNames: named.map((p) => p.displayName),
      participantAvatars: named.map((p) => p.avatarUrl),
      participantCount: row.participantCount ?? ordered.length,
      visibility: row.visibility,
      contextTitle: row.contextTitle,
      startedAt: row.startedAt,
      areaName: row.areaName,
    },
    'LiveCardDto',
  )
}

export function postCardFrom(row: FeedCandidateRow): FeedPostCardDto {
  const view = row.post
  if (view === null || view === undefined) {
    throw new Error('postCardFrom: row has no post payload')
  }
  return { kind: 'post', id: view.post.id, ...view }
}
