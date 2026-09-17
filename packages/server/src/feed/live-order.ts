/**
 * Live discovery ordering (spec SCREEN 13; DB_API §3 "ordering is done in the server tier").
 *
 * Friends scope, in tiers:
 * 1. rooms containing direct friends — closest friends first (more friend participants first);
 * 2. active group rooms of the viewer's groups;
 * 3. rooms with socially adjacent participants (shared group, familiar) — friends of friends;
 * 4. everything else.
 * Within a tier: more publishing participants first, then most recently started, then room id
 * (deterministic).
 *
 * Neighborhood / City / World: participant count, then recency, then id.
 *
 * Only active publishing participants count (spec §60 privacy: viewers are never revealed).
 */
import type {
  MediaState,
  ParticipantStatus,
  RoomContextType,
  Scope,
  ViewerRelation,
} from '@earth/domain'

export interface LiveRankParticipant {
  readonly relationToViewer: ViewerRelation | null
  readonly mediaState: MediaState
  readonly status: ParticipantStatus
  readonly isGuest: boolean
}

export interface LiveRankInput {
  readonly roomId: string
  readonly contextType: RoomContextType
  readonly startedAt: string
  readonly participants: readonly LiveRankParticipant[]
  readonly participantCount?: number | undefined
}

export interface LiveRankFeatures {
  readonly friendCount: number
  readonly adjacentCount: number
  readonly isGroupRoom: boolean
  readonly publisherCount: number
  readonly startedAtMs: number
}

/** Friends-scope tiers, best first. */
export const LIVE_TIERS = ['friends', 'group', 'adjacent', 'other'] as const
export type LiveTier = (typeof LIVE_TIERS)[number]

const TIER_RANK: Readonly<Record<LiveTier, number>> = {
  friends: 0,
  group: 1,
  adjacent: 2,
  other: 3,
}

function isCounted(p: LiveRankParticipant): boolean {
  return p.status === 'active' && p.mediaState !== 'watching' && p.relationToViewer !== 'self'
}

export function liveRankFeatures(room: LiveRankInput): LiveRankFeatures {
  const counted = room.participants.filter(isCounted)
  const friendCount = counted.filter((p) => !p.isGuest && p.relationToViewer === 'friend').length
  const adjacentCount = counted.filter(
    (p) =>
      !p.isGuest && (p.relationToViewer === 'shared_group' || p.relationToViewer === 'familiar'),
  ).length
  const startedAtMs = Date.parse(room.startedAt)
  return {
    friendCount,
    adjacentCount,
    isGroupRoom: room.contextType === 'group',
    publisherCount: room.participantCount ?? counted.length,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Number.NEGATIVE_INFINITY,
  }
}

export function liveTierFor(features: LiveRankFeatures): LiveTier {
  if (features.friendCount > 0) return 'friends'
  if (features.isGroupRoom) return 'group'
  if (features.adjacentCount > 0) return 'adjacent'
  return 'other'
}

function compareBase(a: LiveRankFeatures, b: LiveRankFeatures, idA: string, idB: string): number {
  if (a.publisherCount !== b.publisherCount) return b.publisherCount - a.publisherCount
  if (a.startedAtMs !== b.startedAtMs) return b.startedAtMs - a.startedAtMs
  return idA < idB ? -1 : idA > idB ? 1 : 0
}

export function compareLiveRooms(
  scope: Scope,
  a: LiveRankInput,
  b: LiveRankInput,
  fa: LiveRankFeatures = liveRankFeatures(a),
  fb: LiveRankFeatures = liveRankFeatures(b),
): number {
  if (scope === 'friends') {
    const tierDiff = TIER_RANK[liveTierFor(fa)] - TIER_RANK[liveTierFor(fb)]
    if (tierDiff !== 0) return tierDiff
    if (fa.friendCount !== fb.friendCount) return fb.friendCount - fa.friendCount
    if (fa.adjacentCount !== fb.adjacentCount) return fb.adjacentCount - fa.adjacentCount
  }
  return compareBase(fa, fb, a.roomId, b.roomId)
}

/** Stable, deterministic ordering of live rooms for a scope. Duplicated room ids are dropped. */
export function orderLiveRooms<T extends LiveRankInput>(rooms: readonly T[], scope: Scope): T[] {
  const seen = new Set<string>()
  const unique = rooms.filter((room) => {
    if (seen.has(room.roomId)) return false
    seen.add(room.roomId)
    return true
  })
  const features = new Map<string, LiveRankFeatures>(
    unique.map((room) => [room.roomId, liveRankFeatures(room)]),
  )
  return [...unique].sort((a, b) =>
    compareLiveRooms(scope, a, b, features.get(a.roomId), features.get(b.roomId)),
  )
}
