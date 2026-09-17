import { describe, expect, it } from 'vitest'

import { SCOPES } from '../enums'
import { CANDIDATE_RELATIONSHIPS, parseFeedCandidate } from './candidates'
import { hoursBefore, live, post, seeded, T0, uuidAt } from './fixtures'
import {
  ageHours,
  clamp01,
  FLOOD_FREE_POSTS,
  halfLifeDecay,
  LIVE_BONUS_MAX,
  QUALITY_SATURATION,
  RECENCY_HALF_LIFE_HOURS,
  RELATIONSHIP_SCORE,
  roundScore,
  scoreCandidate,
  scoreComponents,
  SCORE_DECIMALS,
} from './score'

describe('score helpers', () => {
  it('clamp01 / halfLifeDecay / roundScore', () => {
    expect(clamp01(-1)).toBe(0)
    expect(clamp01(2)).toBe(1)
    expect(clamp01(Number.NaN)).toBe(0)
    expect(halfLifeDecay(0, 6)).toBe(1)
    expect(halfLifeDecay(6, 6)).toBeCloseTo(0.5, 10)
    expect(halfLifeDecay(12, 6)).toBeCloseTo(0.25, 10)
    expect(halfLifeDecay(Number.POSITIVE_INFINITY, 6)).toBe(0)
    expect(roundScore(0.1234567891)).toBe(0.123457)
    expect(String(roundScore(1 / 3)).length).toBeLessThanOrEqual(2 + SCORE_DECIMALS)
  })

  it('ageHours handles skew and bad input', () => {
    expect(ageHours(hoursBefore(2), T0)).toBeCloseTo(2, 10)
    expect(ageHours(hoursBefore(-1), T0)).toBe(0)
    expect(ageHours(null, T0)).toBe(Number.POSITIVE_INFINITY)
    expect(ageHours('not a date', T0)).toBe(Number.POSITIVE_INFINITY)
    expect(ageHours(hoursBefore(1), new Date(T0))).toBeCloseTo(1, 10)
    expect(ageHours(hoursBefore(1), new Date(T0).toISOString())).toBeCloseTo(1, 10)
  })
})

describe('scoreComponents', () => {
  it('recency decays with a 6h half-life for posts', () => {
    expect(RECENCY_HALF_LIFE_HOURS).toBe(6)
    expect(scoreComponents(post(1, { createdAt: hoursBefore(0) }), T0).recency).toBe(1)
    expect(scoreComponents(post(1, { createdAt: hoursBefore(6) }), T0).recency).toBeCloseTo(0.5, 10)
    expect(scoreComponents(post(1, { createdAt: hoursBefore(-2) }), T0).recency).toBe(1)
  })

  it('relationship map: friend 1, follow .6, shared_group .5, none 0 — strongest first', () => {
    expect(RELATIONSHIP_SCORE).toEqual({ friend: 1, follow: 0.6, shared_group: 0.5, none: 0 })
    // Strictly decreasing along CANDIDATE_RELATIONSHIPS so "strongest relationship" is unambiguous.
    for (let i = 1; i < CANDIDATE_RELATIONSHIPS.length; i++) {
      const stronger = CANDIDATE_RELATIONSHIPS[i - 1] ?? 'none'
      const weaker = CANDIDATE_RELATIONSHIPS[i] ?? 'none'
      expect(RELATIONSHIP_SCORE[stronger], `${stronger} > ${weaker}`).toBeGreaterThan(
        RELATIONSHIP_SCORE[weaker],
      )
    }
    for (const relationship of CANDIDATE_RELATIONSHIPS) {
      expect(scoreComponents(post(1, { relationship }), T0).relationship).toBe(
        RELATIONSHIP_SCORE[relationship],
      )
    }
    expect(
      scoreComponents(live(1, { relationship: 'none', liveFriendCount: 1 }), T0).relationship,
    ).toBe(1)
  })

  it('now boost: 1 for a fresh Live, decays with room age, participants keep it up; posts 0', () => {
    expect(scoreComponents(post(1), T0).now).toBe(0)
    expect(
      scoreComponents(live(1, { startedAt: hoursBefore(0), liveParticipantCount: 0 }), T0).now,
    ).toBe(1)
    expect(
      scoreComponents(live(1, { startedAt: hoursBefore(2), liveParticipantCount: 0 }), T0).now,
    ).toBeCloseTo(0.5, 10)
    expect(
      scoreComponents(
        live(1, { startedAt: hoursBefore(2), liveParticipantCount: 2, liveFriendCount: 2 }),
        T0,
      ).now,
    ).toBeCloseTo(1, 10)
    expect(
      scoreComponents(
        live(1, { startedAt: hoursBefore(20), liveParticipantCount: 100, liveFriendCount: 100 }),
        T0,
      ).now,
    ).toBeCloseTo(LIVE_BONUS_MAX + 2 ** -10, 6)
    expect(scoreComponents(live(1, { isLive: false }), T0).now).toBe(0)
    expect(scoreComponents(live(1, { startedAt: null, createdAt: hoursBefore(0) }), T0).now).toBe(1)
  })

  it('quality is log-scaled and saturates', () => {
    expect(scoreComponents(post(1), T0).quality).toBe(0)
    const low = scoreComponents(post(1, { reactionCount: 3 }), T0).quality
    const mid = scoreComponents(post(1, { reactionCount: 3, replyCount: 5 }), T0).quality
    const high = scoreComponents(post(1, { reactionCount: QUALITY_SATURATION }), T0).quality
    expect(low).toBeGreaterThan(0)
    expect(mid).toBeGreaterThan(low)
    expect(high).toBe(1)
    expect(scoreComponents(post(1, { reactionCount: 10_000 }), T0).quality).toBe(1)
  })

  it('group context, novelty, interest, place affinity, social, flood', () => {
    expect(scoreComponents(post(1, { sharedGroupCount: 0 }), T0).groupContext).toBe(0)
    expect(scoreComponents(post(1, { sharedGroupCount: 1 }), T0).groupContext).toBe(0.5)
    expect(scoreComponents(post(1, { sharedGroupCount: 3 }), T0).groupContext).toBe(0.875)
    expect(scoreComponents(post(1, { hasSeen: true }), T0).novelty).toBe(0)
    expect(scoreComponents(post(1, { hasSeen: false }), T0).novelty).toBe(1)
    expect(scoreComponents(post(1, { interestMatch: 0.4 }), T0).interest).toBe(0.4)
    expect(scoreComponents(post(1, { placeAffinity: 0.9 }), T0).placeAffinity).toBe(0.9)
    expect(
      scoreComponents(post(1, { relationship: 'shared_group', sharedGroupCount: 1 }), T0).social,
    ).toBeCloseTo(0.65, 10)
    expect(
      scoreComponents(post(1, { relationship: 'friend', sharedGroupCount: 5 }), T0).social,
    ).toBe(1)
    expect(
      scoreComponents(post(1, { authorPostCountRecent: FLOOD_FREE_POSTS }), T0).floodPenalty,
    ).toBe(0)
    expect(
      scoreComponents(post(1, { authorPostCountRecent: FLOOD_FREE_POSTS + 13 }), T0).floodPenalty,
    ).toBe(1)
    expect(scoreComponents(live(1, { authorPostCountRecent: 99 }), T0).floodPenalty).toBe(0)
  })

  it('every component stays in [0, 1] for arbitrary candidates', () => {
    const rand = seeded(7)
    for (let i = 0; i < 200; i++) {
      const isLive = rand() < 0.3
      const base = isLive ? live(i) : post(i)
      const candidate = {
        ...base,
        createdAt: hoursBefore(rand() * 200 - 5),
        startedAt: isLive ? hoursBefore(rand() * 10) : null,
        relationship: CANDIDATE_RELATIONSHIPS[Math.floor(rand() * 4)] ?? 'none',
        sharedGroupCount: Math.floor(rand() * 6),
        liveParticipantCount: Math.floor(rand() * 30),
        liveFriendCount: Math.floor(rand() * 10),
        reactionCount: Math.floor(rand() * 500),
        replyCount: Math.floor(rand() * 100),
        authorPostCountRecent: Math.floor(rand() * 40),
        interestMatch: rand(),
        placeAffinity: rand(),
        hasSeen: rand() < 0.5,
      }
      for (const scope of SCOPES) {
        const { score, components } = scoreCandidate(candidate, scope, T0)
        expect(score).toBeGreaterThanOrEqual(0)
        expect(score).toBeLessThanOrEqual(1)
        for (const [key, value] of Object.entries(components)) {
          expect(value, `${key} for ${candidate.id} in ${scope}`).toBeGreaterThanOrEqual(0)
          expect(value, `${key} for ${candidate.id} in ${scope}`).toBeLessThanOrEqual(1)
        }
      }
    }
  })
})

describe('scoreCandidate', () => {
  it('friends scope: a friend Live right now outranks an old post by a stranger', () => {
    const friendLive = live(1, { liveFriendCount: 1, relationship: 'friend' })
    const strangerPost = post(2, { createdAt: hoursBefore(30), reactionCount: 200 })
    expect(scoreCandidate(friendLive, 'friends', T0).score).toBeGreaterThan(
      scoreCandidate(strangerPost, 'friends', T0).score,
    )
  })

  it('friends scope uses the spec weights', () => {
    const c = post(1, {
      relationship: 'friend',
      sharedGroupCount: 1,
      createdAt: hoursBefore(0),
      reactionCount: 0,
    })
    // relationship 1 × .35 + now 0 + groupContext .5 × .15 + recency 1 × .15 + quality 0 = .575
    expect(scoreCandidate(c, 'friends', T0).score).toBeCloseTo(0.575, 6)
  })

  it('world scopes use interest/social/quality/recency/novelty/placeAffinity', () => {
    const c = post(1, {
      interestMatch: 1,
      placeAffinity: 1,
      createdAt: hoursBefore(0),
      hasSeen: false,
      relationship: 'none',
    })
    // interest .25 + social 0 + quality 0 + recency .15 + novelty .1 + place .1 = .6
    expect(scoreCandidate(c, 'world', T0).score).toBeCloseTo(0.6, 6)
    // neighborhood boosts place affinity: .2 + 0 + 0 + .15 + .05 + .25 = .65
    expect(scoreCandidate(c, 'neighborhood', T0).score).toBeCloseTo(0.65, 6)
    expect(scoreCandidate(c, 'city', T0).score).toBeCloseTo(0.6, 6)
  })

  it('world scope lets a Live use its now boost as recency', () => {
    const oldLive = live(1, { createdAt: hoursBefore(48), startedAt: hoursBefore(0) })
    const oldPost = post(2, { createdAt: hoursBefore(48) })
    expect(scoreCandidate(oldLive, 'world', T0).components.recency).toBeCloseTo(0.0039, 3)
    expect(scoreCandidate(oldLive, 'world', T0).score).toBeGreaterThan(
      scoreCandidate(oldPost, 'world', T0).score,
    )
  })

  it('damps flooding authors and rounds to six decimals', () => {
    const calm = scoreCandidate(
      post(1, { relationship: 'friend', authorPostCountRecent: 1 }),
      'friends',
      T0,
    ).score
    const flood = scoreCandidate(
      post(1, { relationship: 'friend', authorPostCountRecent: 30 }),
      'friends',
      T0,
    ).score
    expect(flood).toBeLessThan(calm)
    expect(flood).toBeCloseTo(calm * 0.85, 5)
    expect(calm).toBe(Number(calm.toFixed(SCORE_DECIMALS)))
    expect(flood).toBe(Number(flood.toFixed(SCORE_DECIMALS)))
  })

  it('is deterministic for the same snapshot', () => {
    const c = post(1, { reactionCount: 7 })
    expect(scoreCandidate(c, 'world', T0)).toEqual(scoreCandidate(c, 'world', new Date(T0)))
  })
})

describe('FeedCandidateSchema', () => {
  it('parses RPC rows, stripping rendering payloads', () => {
    const row = { ...post(1), post: { anything: true }, live: null }
    const parsed = parseFeedCandidate(row)
    expect(parsed).toEqual(post(1))
    expect('post' in parsed).toBe(false)
  })

  it('posts always carry their author; Lives never do', () => {
    expect(() => parseFeedCandidate({ ...post(1), authorHumanId: null })).toThrow()
    expect(parseFeedCandidate(live(1)).authorHumanId).toBeNull()
  })

  it('rejects out-of-range features', () => {
    expect(() => parseFeedCandidate({ ...post(1), interestMatch: 1.5 })).toThrow()
    expect(() => parseFeedCandidate({ ...post(1), id: 'nope' })).toThrow()
    expect(() => parseFeedCandidate({ ...post(1), relationship: 'bestie' })).toThrow()
    expect(() => parseFeedCandidate({ ...post(1), reactionCount: -1 })).toThrow()
    expect(parseFeedCandidate({ ...live(1), authorHumanId: uuidAt(5) }).authorHumanId).toBe(
      uuidAt(5),
    )
  })
})
