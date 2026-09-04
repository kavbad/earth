import { describe, expect, it } from 'vitest'

import { FEED_PAGE_SIZE } from '../constants'
import { EarthError } from '../errors'
import type { FeedCandidate } from './candidates'
import { decodeCursor, encodeCursor } from './cursor'
import { hoursBefore, live, post, seeded, T0, uuidAt } from './fixtures'
import {
  canArrangeAuthors,
  compareRanked,
  isAfterCursor,
  LIVE_FREE_PREFIX,
  MAX_CONSECUTIVE_SAME_AUTHOR,
  maxLivesForSlots,
  POSTS_BETWEEN_LIVES,
  rankFeed,
  type RankedFeedItem,
  type RankedFeedPage,
} from './rank'
import { scoreCandidate } from './score'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function authorRuleHolds(cards: readonly RankedFeedItem[]): boolean {
  let run = 0
  let last: string | null = null
  for (const card of cards) {
    const author = card.kind === 'post' ? card.candidate.authorHumanId : null
    if (author !== null && author === last) run += 1
    else run = author === null ? 0 : 1
    last = author
    if (run > MAX_CONSECUTIVE_SAME_AUTHOR) return false
  }
  return true
}

function liveRuleHolds(cards: readonly RankedFeedItem[]): boolean {
  for (let i = LIVE_FREE_PREFIX; i < cards.length; i++) {
    if (cards[i]?.kind !== 'live') continue
    for (let j = Math.max(0, i - POSTS_BETWEEN_LIVES); j < i; j++) {
      if (cards[j]?.kind === 'live') return false
    }
  }
  return true
}

function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const a = out[i]
    const b = out[j]
    if (a !== undefined && b !== undefined) {
      out[i] = b
      out[j] = a
    }
  }
  return out
}

/** 60 candidates: 48 posts from 12 authors (varied features) + 12 Lives. */
function sixtyCandidates(): FeedCandidate[] {
  const rand = seeded(2026)
  const candidates: FeedCandidate[] = []
  for (let i = 0; i < 48; i++) {
    candidates.push(
      post(i, {
        authorHumanId: uuidAt(i % 12, '10000000-0000-4000-8000'),
        createdAt: hoursBefore(rand() * 48),
        relationship: (['friend', 'follow', 'shared_group', 'none'] as const)[i % 4] ?? 'none',
        sharedGroupCount: i % 3,
        reactionCount: Math.floor(rand() * 40),
        replyCount: Math.floor(rand() * 10),
        authorPostCountRecent: 4,
        interestMatch: rand(),
        placeAffinity: rand(),
        hasSeen: rand() < 0.2,
      }),
    )
  }
  for (let i = 0; i < 12; i++) {
    candidates.push(
      live(100 + i, {
        startedAt: hoursBefore(rand() * 3),
        liveParticipantCount: 1 + Math.floor(rand() * 6),
        liveFriendCount: i % 3,
        relationship: i % 2 === 0 ? 'friend' : 'none',
      }),
    )
  }
  return candidates
}

function allPages(
  candidates: readonly FeedCandidate[],
  pageSize: number,
  scope: 'friends' | 'world' = 'friends',
): RankedFeedPage[] {
  const pages: RankedFeedPage[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 100; guard++) {
    const page: RankedFeedPage = rankFeed(candidates, { scope, now: T0, pageSize, cursor })
    pages.push(page)
    cursor = page.nextCursor
    if (cursor === null) break
  }
  return pages
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ordering primitives', () => {
  it('compareRanked orders by score desc then id asc', () => {
    expect(compareRanked({ score: 0.5, id: 'b' }, { score: 0.6, id: 'a' })).toBeGreaterThan(0)
    expect(compareRanked({ score: 0.5, id: 'a' }, { score: 0.5, id: 'b' })).toBeLessThan(0)
    expect(compareRanked({ score: 0.5, id: 'a' }, { score: 0.5, id: 'a' })).toBe(0)
  })

  it('isAfterCursor is strict keyset', () => {
    const cursor = { lastScore: 0.5, lastId: 'b' }
    expect(isAfterCursor({ score: 0.4, id: 'a' }, cursor)).toBe(true)
    expect(isAfterCursor({ score: 0.5, id: 'c' }, cursor)).toBe(true)
    expect(isAfterCursor({ score: 0.5, id: 'b' }, cursor)).toBe(false)
    expect(isAfterCursor({ score: 0.5, id: 'a' }, cursor)).toBe(false)
    expect(isAfterCursor({ score: 0.6, id: 'z' }, cursor)).toBe(false)
  })

  it('maxLivesForSlots follows the spacing rule', () => {
    expect(maxLivesForSlots(0)).toBe(0)
    expect(maxLivesForSlots(4)).toBe(4)
    expect(maxLivesForSlots(8)).toBe(4)
    expect(maxLivesForSlots(9)).toBe(5)
    expect(maxLivesForSlots(20)).toBe(7)
  })
})

describe('canArrangeAuthors (feasibility oracle)', () => {
  function bruteForce(
    authors: readonly (string | null)[],
    lastAuthor: string | null,
    run: number,
  ): boolean {
    const n = authors.length
    const used = new Array<boolean>(n).fill(false)
    const search = (placed: number, last: string | null, currentRun: number): boolean => {
      if (placed === n) return true
      const tried = new Set<string>()
      for (let i = 0; i < n; i++) {
        if (used[i]) continue
        const author = authors[i] ?? null
        const key = author ?? `__anon_${i}`
        if (tried.has(key)) continue
        tried.add(key)
        const nextRun = author === null ? 0 : author === last ? currentRun + 1 : 1
        if (nextRun > MAX_CONSECUTIVE_SAME_AUTHOR) continue
        used[i] = true
        if (search(placed + 1, author, nextRun)) return true
        used[i] = false
      }
      return false
    }
    return search(0, lastAuthor, run)
  }

  it('agrees with brute force on random small multisets and states', () => {
    const rand = seeded(11)
    const pool = ['A', 'B', 'C', null]
    for (let trial = 0; trial < 400; trial++) {
      const size = Math.floor(rand() * 8)
      const authors = Array.from(
        { length: size },
        () => pool[Math.floor(rand() * pool.length)] ?? null,
      )
      const lastAuthor = rand() < 0.5 ? null : (['A', 'B', 'C'][Math.floor(rand() * 3)] ?? null)
      const run = lastAuthor === null ? 0 : 1 + Math.floor(rand() * 2)
      expect(
        canArrangeAuthors(authors, { lastAuthor, run }),
        JSON.stringify({ authors, lastAuthor, run }),
      ).toBe(bruteForce(authors, lastAuthor, run))
    }
  })

  it('known cases', () => {
    expect(canArrangeAuthors(['A', 'A'])).toBe(true)
    expect(canArrangeAuthors(['A', 'A', 'A'])).toBe(false)
    expect(canArrangeAuthors(['A', 'A', 'A', 'B'])).toBe(true)
    expect(canArrangeAuthors(['A', 'A', 'A', 'A', 'A', 'B'])).toBe(false)
    expect(canArrangeAuthors(['A', 'A', 'A', 'A', 'A', 'A', 'B', 'C'])).toBe(true)
    expect(canArrangeAuthors(['A', 'A', 'A', null])).toBe(true)
    expect(canArrangeAuthors(['A'], { lastAuthor: 'A', run: 2 })).toBe(false)
    expect(canArrangeAuthors(['B', 'A'], { lastAuthor: 'A', run: 2 })).toBe(true)
  })
})

describe('rankFeed', () => {
  it('orders by (score desc, id asc) when no diversity rule applies', () => {
    const candidates = [
      post(1, { reactionCount: 10 }),
      post(2, { reactionCount: 10 }),
      post(3, { reactionCount: 50 }),
      post(4, { reactionCount: 0 }),
    ]
    const page = rankFeed(candidates, { scope: 'world', now: T0 })
    const expected = candidates
      .map((c) => ({ id: c.id, score: scoreCandidate(c, 'world', T0).score }))
      .sort(compareRanked)
      .map((c) => c.id)
    expect(page.cards.map((c) => c.id)).toEqual(expected)
    expect(page.cards.map((c) => c.id)).toEqual([uuidAt(3), uuidAt(1), uuidAt(2), uuidAt(4)])
    expect(page.nextCursor).toBeNull()
    expect(page.snapshotAt).toBe(new Date(T0).toISOString())
  })

  it('is deterministic and independent of input order', () => {
    const candidates = sixtyCandidates()
    const a = rankFeed(candidates, { scope: 'friends', now: T0 })
    const b = rankFeed(candidates, { scope: 'friends', now: T0 })
    const c = rankFeed(shuffle(candidates, seeded(3)), { scope: 'friends', now: T0 })
    expect(a).toEqual(b)
    expect(c.cards.map((x) => x.id)).toEqual(a.cards.map((x) => x.id))
    expect(a.cards.length).toBe(FEED_PAGE_SIZE)
  })

  it('cursor continuation never repeats or skips a post across pages (60 candidates)', () => {
    const candidates = sixtyCandidates()
    for (const pageSize of [7, 20]) {
      const pages = allPages(candidates, pageSize)
      const postIds = pages.flatMap((p) =>
        p.cards.filter((c) => c.kind === 'post').map((c) => c.id),
      )
      const expected = candidates.filter((c) => c.kind === 'post').map((c) => c.id)
      expect(new Set(postIds).size, `pageSize ${pageSize}: no repeats`).toBe(postIds.length)
      expect([...postIds].sort(), `pageSize ${pageSize}: no skips`).toEqual([...expected].sort())
      expect(pages.length).toBeGreaterThan(1)
      expect(pages.at(-1)?.nextCursor).toBeNull()
      for (const page of pages) {
        expect(page.snapshotAt).toBe(pages[0]?.snapshotAt)
        expect(page.cards.length).toBeLessThanOrEqual(pageSize)
      }
    }
  })

  it('Lives only appear on the first page', () => {
    const candidates = sixtyCandidates()
    const pages = allPages(candidates, 7)
    const firstLives = pages[0]?.cards.filter((c) => c.kind === 'live') ?? []
    expect(firstLives.length).toBeGreaterThan(0)
    for (const page of pages.slice(1)) {
      expect(page.cards.some((c) => c.kind === 'live')).toBe(false)
    }
    const liveIds = new Set(candidates.filter((c) => c.kind === 'live').map((c) => c.id))
    for (const card of firstLives) expect(liveIds.has(card.id)).toBe(true)
    expect(new Set(firstLives.map((c) => c.id)).size).toBe(firstLives.length)
  })

  it('diversity rules hold on every page', () => {
    const candidates = sixtyCandidates()
    for (const pageSize of [5, 7, 20]) {
      for (const page of allPages(candidates, pageSize)) {
        expect(authorRuleHolds(page.cards)).toBe(true)
        expect(liveRuleHolds(page.cards)).toBe(true)
      }
    }
  })

  it('keeps scores strictly monotonic across page boundaries', () => {
    const pages = allPages(sixtyCandidates(), 7)
    for (let i = 1; i < pages.length; i++) {
      const prev = pages[i - 1]?.cards.filter((c) => c.kind === 'post') ?? []
      const next = pages[i]?.cards.filter((c) => c.kind === 'post') ?? []
      const minPrev = Math.min(...prev.map((c) => c.score))
      const maxNext = Math.max(...next.map((c) => c.score))
      expect(maxNext).toBeLessThanOrEqual(minPrev)
    }
  })

  it('an author flood shortens pages instead of breaking the cursor', () => {
    const author = uuidAt(1, '10000000-0000-4000-8000')
    const flood = Array.from({ length: 10 }, (_, i) =>
      post(i, { authorHumanId: author, reactionCount: 100 - i, authorPostCountRecent: 10 }),
    )
    const others = [post(50, { reactionCount: 1 }), post(51, { reactionCount: 1 })]
    const candidates = [...flood, ...others]
    const pages = allPages(candidates, 6, 'world')
    const ids = pages.flatMap((p) => p.cards.map((c) => c.id))
    expect(new Set(ids).size).toBe(12)
    expect([...ids].sort()).toEqual(candidates.map((c) => c.id).sort())
    for (const page of pages) {
      expect(page.cards.length).toBeGreaterThan(0)
      expect(authorRuleHolds(page.cards)).toBe(true)
    }
    expect(pages.length).toBeGreaterThan(2)
  })

  it('places a lower-scored separator to keep the top of the page diverse', () => {
    const author = uuidAt(1, '10000000-0000-4000-8000')
    const candidates = [
      post(1, { authorHumanId: author, reactionCount: 50 }),
      post(2, { authorHumanId: author, reactionCount: 40 }),
      post(3, { authorHumanId: author, reactionCount: 30 }),
      post(4, { reactionCount: 1 }),
    ]
    const page = rankFeed(candidates, { scope: 'world', now: T0 })
    expect(page.cards.map((c) => c.id)).toEqual([uuidAt(1), uuidAt(2), uuidAt(4), uuidAt(3)])
    expect(page.nextCursor).toBeNull()
  })

  it('at most 4 Lives at the top, then one Live per 4 posts', () => {
    const candidates = [
      ...Array.from({ length: 8 }, (_, i) => live(i, { liveFriendCount: 3 })),
      ...Array.from({ length: 16 }, (_, i) => post(100 + i, { relationship: 'friend' })),
    ]
    const page = rankFeed(candidates, { scope: 'friends', now: T0, pageSize: 20 })
    const kinds = page.cards.map((c) => c.kind)
    expect(kinds.slice(0, 4)).toEqual(['live', 'live', 'live', 'live'])
    expect(kinds.slice(4, 8)).toEqual(['post', 'post', 'post', 'post'])
    expect(kinds[8]).toBe('live')
    expect(liveRuleHolds(page.cards)).toBe(true)
    expect(page.cards.filter((c) => c.kind === 'live').length).toBeLessThanOrEqual(
      maxLivesForSlots(20),
    )
  })

  it('gives the slots of unplaceable Lives back to posts so page 1 stays full', () => {
    // Seven stale Lives rank below every post; rule 2 lets only one of them onto the page.
    const staleLives = Array.from({ length: 7 }, (_, i) =>
      live(i, { liveParticipantCount: 0, startedAt: hoursBefore(40) }),
    )
    const posts = Array.from({ length: 100 }, (_, i) =>
      post(100 + i, { relationship: 'friend', reactionCount: 50 }),
    )
    const candidates = [...staleLives, ...posts]
    const first = rankFeed(candidates, { scope: 'friends', now: T0, pageSize: 20 })
    expect(first.cards.length).toBe(20)
    expect(first.cards.filter((c) => c.kind === 'live').length).toBe(1)
    expect(liveRuleHolds(first.cards)).toBe(true)
    expect(first.nextCursor).not.toBeNull()

    const pages = allPages(candidates, 20)
    const postIds = pages.flatMap((p) => p.cards.filter((c) => c.kind === 'post').map((c) => c.id))
    expect(new Set(postIds).size).toBe(100)
    for (const page of pages.slice(0, -1)) expect(page.cards.length).toBe(20)
  })

  it('every page but the last is full when the author rule cannot bind (random candidates)', () => {
    const rand = seeded(99)
    for (let trial = 0; trial < 25; trial++) {
      const postCount = 1 + Math.floor(rand() * 60)
      const liveCount = Math.floor(rand() * 12)
      const candidates: FeedCandidate[] = [
        ...Array.from({ length: postCount }, (_, i) =>
          post(i, {
            createdAt: hoursBefore(rand() * 48),
            reactionCount: Math.floor(rand() * 60),
            relationship: rand() < 0.5 ? 'friend' : 'none',
          }),
        ),
        ...Array.from({ length: liveCount }, (_, i) =>
          live(200 + i, {
            startedAt: hoursBefore(rand() * 40),
            liveParticipantCount: Math.floor(rand() * 4),
            liveFriendCount: Math.floor(rand() * 2),
          }),
        ),
      ]
      const pageSize = 3 + Math.floor(rand() * 18)
      const pages = allPages(candidates, pageSize, rand() < 0.5 ? 'friends' : 'world')
      const label = `trial ${trial}: ${postCount} posts, ${liveCount} lives, pageSize ${pageSize}`
      for (const page of pages.slice(0, -1)) expect(page.cards.length, label).toBe(pageSize)
      for (const page of pages) {
        expect(authorRuleHolds(page.cards), label).toBe(true)
        expect(liveRuleHolds(page.cards), label).toBe(true)
      }
      const postIds = pages.flatMap((p) =>
        p.cards.filter((c) => c.kind === 'post').map((c) => c.id),
      )
      expect(new Set(postIds).size, label).toBe(postCount)
    }
  })

  it('a page always advances the cursor when posts remain', () => {
    const candidates = [
      ...Array.from({ length: 5 }, (_, i) => live(i, { liveFriendCount: 3 })),
      post(50),
      post(51),
    ]
    const first = rankFeed(candidates, { scope: 'friends', now: T0, pageSize: 4 })
    expect(first.cards.filter((c) => c.kind === 'post').length).toBe(1)
    expect(first.nextCursor).not.toBeNull()
    const second = rankFeed(candidates, {
      scope: 'friends',
      now: T0,
      pageSize: 4,
      cursor: first.nextCursor,
    })
    expect(second.cards.map((c) => c.kind)).toEqual(['post'])
    expect(second.nextCursor).toBeNull()
  })

  it('scores later pages with the snapshot time, not the wall clock', () => {
    const candidates = sixtyCandidates()
    const first = rankFeed(candidates, { scope: 'friends', now: T0, pageSize: 7 })
    const laterNow = T0 + 5 * 3_600_000
    const second = rankFeed(candidates, {
      scope: 'friends',
      now: laterNow,
      pageSize: 7,
      cursor: first.nextCursor,
    })
    const secondAtT0 = rankFeed(candidates, {
      scope: 'friends',
      now: T0,
      pageSize: 7,
      cursor: first.nextCursor,
    })
    expect(second).toEqual(secondAtT0)
    expect(second.snapshotAt).toBe(first.snapshotAt)
  })

  it('rejects cursors from another scope or area and bad page sizes', () => {
    const first = rankFeed(sixtyCandidates(), { scope: 'friends', now: T0, pageSize: 7 })
    expect(() => rankFeed([], { scope: 'world', now: T0, cursor: first.nextCursor })).toThrow(
      EarthError,
    )
    const areaCursor = encodeCursor({
      ...decodeCursor(first.nextCursor ?? '', { scope: 'friends' }),
      scope: 'city',
      areaId: uuidAt(9),
    })
    expect(() =>
      rankFeed([], { scope: 'city', now: T0, cursor: areaCursor, areaId: uuidAt(10) }),
    ).toThrow(EarthError)
    expect(
      rankFeed([], { scope: 'city', now: T0, cursor: areaCursor, areaId: uuidAt(9) }).cards,
    ).toEqual([])
    expect(() => rankFeed([], { scope: 'world', now: T0, pageSize: 0 })).toThrow(EarthError)
    expect(() => rankFeed([], { scope: 'world', now: 'never' })).toThrow(EarthError)
  })

  it('ignores duplicate candidate ids and an empty cursor', () => {
    const c = post(1)
    const page = rankFeed([c, { ...c, reactionCount: 99 }], { scope: 'world', now: T0, cursor: '' })
    expect(page.cards.length).toBe(1)
    expect(page.cards[0]?.candidate.reactionCount).toBe(0)
  })

  it('returns an empty page without cursor for no candidates', () => {
    expect(rankFeed([], { scope: 'friends', now: T0 })).toEqual({
      cards: [],
      nextCursor: null,
      snapshotAt: new Date(T0).toISOString(),
    })
  })
})
