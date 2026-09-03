/**
 * Deterministic candidate fixtures for feed tests (not exported from the package).
 */
import type { FeedCandidate } from './candidates'

export const T0 = Date.UTC(2026, 8, 3, 12, 0, 0)

export function uuidAt(n: number, prefix = '00000000-0000-4000-8000'): string {
  return `${prefix}-${n.toString(16).padStart(12, '0')}`
}

export function hoursBefore(hours: number, base: number = T0): string {
  return new Date(base - hours * 3_600_000).toISOString()
}

export function post(n: number, overrides: Partial<FeedCandidate> = {}): FeedCandidate {
  return {
    kind: 'post',
    id: uuidAt(n),
    authorHumanId: uuidAt(n, '10000000-0000-4000-8000'),
    createdAt: hoursBefore(1),
    startedAt: null,
    relationship: 'none',
    sharedGroupCount: 0,
    isLive: false,
    liveParticipantCount: 0,
    liveFriendCount: 0,
    reactionCount: 0,
    replyCount: 0,
    authorPostCountRecent: 1,
    interestMatch: 0,
    placeAffinity: 0,
    hasSeen: false,
    audience: 'world',
    areaId: null,
    ...overrides,
  }
}

export function live(n: number, overrides: Partial<FeedCandidate> = {}): FeedCandidate {
  return {
    ...post(n),
    kind: 'live',
    id: uuidAt(n, '20000000-0000-4000-8000'),
    authorHumanId: null,
    startedAt: hoursBefore(0.25),
    isLive: true,
    liveParticipantCount: 2,
    liveFriendCount: 0,
    audience: 'friends',
    ...overrides,
  }
}

/** mulberry32 — a tiny seeded PRNG so fixtures are reproducible. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
