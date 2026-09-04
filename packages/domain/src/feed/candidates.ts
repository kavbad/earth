/**
 * Feed candidates — the feature rows `feed_candidates(scope, area_id, snapshot_at, limit)` returns
 * (ARCHITECTURE §9 step 1; DB_API §4). The RPC has already applied audience, blocks and membership;
 * the domain only scores, diversifies and paginates. Rendering payloads (`PostViewDto`, live card
 * fields) travel alongside these features and are matched back by `id` in the server tier.
 */
import { z } from 'zod'

import { AudienceSchema } from '../enums'
import { IsoDateTimeSchema, NonNegativeIntSchema } from '../dto/common'

/** Cards that can be ranked; presence rows are assembled by the server (`./presence.ts`), not ranked. */
export const FEED_CANDIDATE_KINDS = ['post', 'live'] as const
export type FeedCandidateKind = (typeof FEED_CANDIDATE_KINDS)[number]
export const FeedCandidateKindSchema = z.enum(FEED_CANDIDATE_KINDS)

/**
 * Strongest relationship between the viewer and the author (posts) or any consenting participant
 * (Lives). Follow is not friendship (spec §128); shared group is not friendship either (spec §23).
 */
export const CANDIDATE_RELATIONSHIPS = ['friend', 'follow', 'shared_group', 'none'] as const
export type CandidateRelationship = (typeof CANDIDATE_RELATIONSHIPS)[number]
export const CandidateRelationshipSchema = z.enum(CANDIDATE_RELATIONSHIPS)

const UnitIntervalSchema = z.number().min(0).max(1)

export const FeedCandidateSchema = z
  .object({
    kind: FeedCandidateKindSchema,
    /** Post id or room id; the keyset cursor key together with the score. */
    id: z.uuid(),
    /**
     * Post author — never `null` for posts, visitor feeds included (spec §29 `author_human_id`;
     * the author-diversity rule of ARCHITECTURE §9 silently stops applying without it). `null` for
     * Lives: rooms are not authored.
     */
    authorHumanId: z.uuid().nullable(),
    createdAt: IsoDateTimeSchema,
    /** Room `started_at`; `null` for posts. */
    startedAt: IsoDateTimeSchema.nullable(),
    relationship: CandidateRelationshipSchema,
    sharedGroupCount: NonNegativeIntSchema,
    isLive: z.boolean(),
    liveParticipantCount: NonNegativeIntSchema,
    liveFriendCount: NonNegativeIntSchema,
    reactionCount: NonNegativeIntSchema,
    replyCount: NonNegativeIntSchema,
    /** Posts by the same author in the candidate window (anti-flood, spec §64). */
    authorPostCountRecent: NonNegativeIntSchema,
    interestMatch: UnitIntervalSchema,
    placeAffinity: UnitIntervalSchema,
    hasSeen: z.boolean(),
    audience: AudienceSchema,
    areaId: z.uuid().nullable(),
  })
  .refine((candidate) => candidate.kind !== 'post' || candidate.authorHumanId !== null, {
    message: 'a post candidate must carry its author',
    path: ['authorHumanId'],
  })
export type FeedCandidate = z.infer<typeof FeedCandidateSchema>

/** Parses one RPC row, stripping rendering payload keys. Throws a `ZodError` on a bad row. */
export function parseFeedCandidate(row: unknown): FeedCandidate {
  return FeedCandidateSchema.parse(row)
}
