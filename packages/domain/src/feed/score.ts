/**
 * Candidate scoring (spec §65, §68; ARCHITECTURE §9 step 2). Every component is in [0, 1] and the
 * weights sum to 1, so `score` is in [0, 1]. Scores are rounded to `SCORE_DECIMALS` so the keyset
 * cursor round-trips through JSON exactly; ties are broken by `id` in `rankFeed`.
 *
 * Scoring must use the page's `snapshotAt`, not the wall clock, so a candidate scores identically
 * on every page of one scroll (otherwise the keyset would repeat or skip cards).
 */
import type { Scope } from '../enums'
import { type CandidateRelationship, type FeedCandidate } from './candidates'
import { FRIENDS_WEIGHTS, weightsForScope } from './weights'

// ---------------------------------------------------------------------------
// Tunables (spec §65 "Tune via data")
// ---------------------------------------------------------------------------

/** Post recency halves every 6 hours. */
export const RECENCY_HALF_LIFE_HOURS = 6
/** A Live's "now" boost halves every 2 hours of room age (participants keep it up). */
export const LIVE_NOW_HALF_LIFE_HOURS = 2
/** Bonus per active participant / per direct friend in a Live, capped at `LIVE_BONUS_MAX`. */
export const LIVE_PARTICIPANT_BONUS = 0.1
export const LIVE_FRIEND_BONUS = 0.15
export const LIVE_BONUS_MAX = 0.5
/** Reactions + 2×replies at which quality saturates to 1 (log scale). */
export const QUALITY_SATURATION = 50
export const REPLY_QUALITY_WEIGHT = 2
/**
 * Spec §65 relationship map, strictly decreasing along `CANDIDATE_RELATIONSHIPS` (strongest first)
 * so `feedRelationshipFor` and this table agree on what "strongest" means. An explicit follow
 * outranks incidental shared-group membership (spec §64: shared-group strangers must not flood the
 * feed; spec §128: group member is not automatically friend, friend is not follow).
 */
export const RELATIONSHIP_SCORE: Readonly<Record<CandidateRelationship, number>> = {
  friend: 1,
  follow: 0.6,
  shared_group: 0.5,
  none: 0,
}
/** World "social" blends relationship with group context (spec §68 "socially adjacent"). */
export const SOCIAL_GROUP_CONTEXT_WEIGHT = 0.3
/** Anti-flood (spec §64): beyond this many recent posts by one author, the score is damped. */
export const FLOOD_FREE_POSTS = 3
export const FLOOD_PENALTY_SPAN = 10
export const FLOOD_PENALTY_MAX = 0.15
export const SCORE_DECIMALS = 6

const HOUR_MS = 3_600_000
const SCORE_SCALE = 10 ** SCORE_DECIMALS

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScoreComponents {
  readonly relationship: number
  readonly now: number
  readonly groupContext: number
  readonly recency: number
  readonly quality: number
  readonly interest: number
  readonly social: number
  readonly novelty: number
  readonly placeAffinity: number
  /** 0 = no damping, 1 = full `FLOOD_PENALTY_MAX` damping. Multiplies the weighted sum. */
  readonly floodPenalty: number
}

export interface CandidateScore {
  readonly score: number
  readonly components: ScoreComponents
}

export type NowInput = Date | string | number

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function toMs(value: NowInput): number {
  return value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : Date.parse(value)
}

/** Hours between `at` and `now`; negative ages (clock skew) are 0; unparsable dates are infinite. */
export function ageHours(at: string | null, now: NowInput): number {
  if (at === null) return Number.POSITIVE_INFINITY
  const atMs = Date.parse(at)
  const nowMs = toMs(now)
  if (!Number.isFinite(atMs) || !Number.isFinite(nowMs)) return Number.POSITIVE_INFINITY
  return Math.max(0, (nowMs - atMs) / HOUR_MS)
}

/** `2^(-age / halfLife)`: 1 when fresh, 0.5 after one half-life, → 0. */
export function halfLifeDecay(age: number, halfLifeHours: number): number {
  if (!Number.isFinite(age)) return 0
  return clamp01(Math.pow(2, -age / halfLifeHours))
}

export function roundScore(score: number): number {
  return Math.round(clamp01(score) * SCORE_SCALE) / SCORE_SCALE
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export function scoreComponents(candidate: FeedCandidate, now: NowInput): ScoreComponents {
  const isLive = candidate.kind === 'live' && candidate.isLive
  const recency = halfLifeDecay(ageHours(candidate.createdAt, now), RECENCY_HALF_LIFE_HOURS)

  let nowBoost = 0
  if (isLive) {
    const liveAge = ageHours(candidate.startedAt ?? candidate.createdAt, now)
    const bonus = Math.min(
      LIVE_BONUS_MAX,
      LIVE_PARTICIPANT_BONUS * candidate.liveParticipantCount +
        LIVE_FRIEND_BONUS * candidate.liveFriendCount,
    )
    nowBoost = clamp01(halfLifeDecay(liveAge, LIVE_NOW_HALF_LIFE_HOURS) + bonus)
  }

  const engagement = candidate.reactionCount + REPLY_QUALITY_WEIGHT * candidate.replyCount
  const quality = clamp01(Math.log1p(Math.max(0, engagement)) / Math.log1p(QUALITY_SATURATION))

  const relationship =
    candidate.kind === 'live' && candidate.liveFriendCount > 0
      ? 1
      : RELATIONSHIP_SCORE[candidate.relationship]

  const groupContext =
    candidate.sharedGroupCount > 0 ? clamp01(1 - Math.pow(2, -candidate.sharedGroupCount)) : 0

  const floodPenalty =
    candidate.kind === 'post'
      ? clamp01((candidate.authorPostCountRecent - FLOOD_FREE_POSTS) / FLOOD_PENALTY_SPAN)
      : 0

  return {
    relationship,
    now: nowBoost,
    groupContext,
    recency,
    quality,
    interest: clamp01(candidate.interestMatch),
    social: clamp01(relationship + SOCIAL_GROUP_CONTEXT_WEIGHT * groupContext),
    novelty: candidate.hasSeen ? 0 : 1,
    placeAffinity: clamp01(candidate.placeAffinity),
    floodPenalty,
  }
}

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

/**
 * Weighted score for `scope` at time `now` (the page snapshot). Friends uses `FRIENDS_WEIGHTS`;
 * the other radii use World-shaped weights where a Live's recency is replaced by its `now`
 * boost when larger (spec §68 "public Lives", §69 "currently compelling Live").
 */
export function scoreCandidate(
  candidate: FeedCandidate,
  scope: Scope,
  now: NowInput,
): CandidateScore {
  const c = scoreComponents(candidate, now)
  let weighted: number
  if (scope === 'friends') {
    const w = FRIENDS_WEIGHTS
    weighted =
      w.relationship * c.relationship +
      w.now * c.now +
      w.groupContext * c.groupContext +
      w.recency * c.recency +
      w.quality * c.quality
  } else {
    const w = weightsForScope(scope)
    const recency = candidate.kind === 'live' ? Math.max(c.recency, c.now) : c.recency
    weighted =
      w.interest * c.interest +
      w.social * c.social +
      w.quality * c.quality +
      w.recency * recency +
      w.novelty * c.novelty +
      w.placeAffinity * c.placeAffinity
  }
  const damped = weighted * (1 - FLOOD_PENALTY_MAX * c.floodPenalty)
  return { score: roundScore(damped), components: c }
}
