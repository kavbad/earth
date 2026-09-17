/**
 * Feed ranking (ARCHITECTURE §9 steps 2–3; spec §63, §70).
 *
 * Order: `(score desc, id asc)` — deterministic for a given candidate set and snapshot.
 *
 * Pagination is a pure keyset over that order. A page's *post set* is always a prefix of the
 * ordered post list after the cursor, so pages never repeat or skip a post; the diversity pass only
 * reorders *within* the page. When the diversity rules cannot be satisfied for a full page (one
 * author dominating the top of the ranking), the page is shortened to the largest prefix that can
 * be arranged — an author flood yields shorter pages, never a broken cursor (spec §64).
 *
 * Diversity rules:
 * 1. No more than 2 consecutive cards by the same author (posts; Lives are rooms, not authored,
 *    and act as separators).
 * 2. After the first 4 cards, at most 1 Live card per 4 posts: a Live at position ≥ 4 needs the
 *    4 previous cards to contain no Live.
 *
 * Lives appear on the first page only (cursor absent); a Live that does not fit page 1 is dropped
 * (it is still discoverable on the Live tab) and the slot it was reserved is given back to posts, so
 * a page is only ever shorter than `pageSize` when the candidates run out or an author flood makes
 * a full page impossible. Later pages exclude Lives entirely.
 */
import { FEED_PAGE_SIZE } from '../constants'
import type { Scope } from '../enums'
import { EarthError } from '../errors'
import type { FeedCandidate, FeedCandidateKind } from './candidates'
import { decodeCursor, encodeCursor, type FeedCursor } from './cursor'
import { scoreCandidate, type NowInput, type ScoreComponents } from './score'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RankedFeedItem<T extends FeedCandidate = FeedCandidate> {
  readonly id: string
  readonly kind: FeedCandidateKind
  readonly score: number
  readonly components: ScoreComponents
  readonly candidate: T
}

export interface RankFeedOptions {
  readonly scope: Scope
  readonly now: NowInput
  readonly pageSize?: number
  readonly cursor?: string | null
  readonly areaId?: string | null
}

export interface RankedFeedPage<T extends FeedCandidate = FeedCandidate> {
  readonly cards: readonly RankedFeedItem<T>[]
  readonly nextCursor: string | null
  readonly snapshotAt: string
}

/** Diversity rule 1: maximum run of consecutive cards by one author. */
export const MAX_CONSECUTIVE_SAME_AUTHOR = 2
/** Diversity rule 2: cards at the top that may be Lives without spacing. */
export const LIVE_FREE_PREFIX = 4
/** Diversity rule 2: posts required between two Lives after the free prefix. */
export const POSTS_BETWEEN_LIVES = 4

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

export function compareRanked(
  a: { score: number; id: string },
  b: { score: number; id: string },
): number {
  if (a.score !== b.score) return a.score > b.score ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** True when `item` comes strictly after the cursor position in `(score desc, id asc)` order. */
export function isAfterCursor(
  item: { score: number; id: string },
  cursor: Pick<FeedCursor, 'lastScore' | 'lastId'>,
): boolean {
  return (
    item.score < cursor.lastScore || (item.score === cursor.lastScore && item.id > cursor.lastId)
  )
}

function toIso(now: NowInput): string {
  const date = now instanceof Date ? now : new Date(now)
  if (Number.isNaN(date.getTime())) {
    throw new EarthError('invalid_input', { details: { field: 'now', reason: 'invalid_date' } })
  }
  return date.toISOString()
}

// ---------------------------------------------------------------------------
// Author-run feasibility oracle
// ---------------------------------------------------------------------------

interface RunState {
  readonly lastAuthor: string | null
  readonly run: number
}

const NO_RUN: RunState = { lastAuthor: null, run: 0 }

function advance(state: RunState, author: string | null): RunState {
  if (author === null) return NO_RUN
  return state.lastAuthor === author
    ? { lastAuthor: author, run: state.run + 1 }
    : { lastAuthor: author, run: 1 }
}

function wouldExceedRun(state: RunState, author: string | null): boolean {
  return author !== null && state.lastAuthor === author && state.run >= MAX_CONSECUTIVE_SAME_AUTHOR
}

/**
 * Can `authors` (posts still to place, `null` = unauthored) be arranged after `state` with no more
 * than `MAX_CONSECUTIVE_SAME_AUTHOR` in a row? Greedy "most remaining first, never blocked" — exact
 * for this constraint (the classic happy-string argument); verified against brute force in tests.
 */
export function canArrangeAuthors(
  authors: readonly (string | null)[],
  state: RunState = NO_RUN,
): boolean {
  const counts = new Map<string, number>()
  let anonymous = 0
  for (const author of authors) {
    if (author === null) anonymous += 1
    else counts.set(author, (counts.get(author) ?? 0) + 1)
  }
  let remaining = authors.length
  let current = state
  while (remaining > 0) {
    let best: string | null = null
    let bestCount = 0
    for (const [author, count] of counts) {
      if (count > bestCount && !wouldExceedRun(current, author)) {
        best = author
        bestCount = count
      }
    }
    if (best !== null && (bestCount > 1 || anonymous === 0)) {
      counts.set(best, bestCount - 1)
      if (bestCount - 1 === 0) counts.delete(best)
      current = advance(current, best)
    } else if (anonymous > 0) {
      anonymous -= 1
      current = NO_RUN
    } else if (best !== null) {
      counts.delete(best)
      current = advance(current, best)
    } else {
      return false
    }
    remaining -= 1
  }
  return true
}

// ---------------------------------------------------------------------------
// Page assembly
// ---------------------------------------------------------------------------

function liveAllowedAt<T extends FeedCandidate>(output: readonly RankedFeedItem<T>[]): boolean {
  const position = output.length
  if (position < LIVE_FREE_PREFIX) return true
  for (let i = Math.max(0, position - POSTS_BETWEEN_LIVES); i < position; i++) {
    if (output[i]?.kind === 'live') return false
  }
  return true
}

/** Upper bound of Lives a page of `slots` can hold under rule 2 (used to reserve post slots). */
export function maxLivesForSlots(slots: number): number {
  let count = 0
  let lastLive = Number.NEGATIVE_INFINITY
  for (let i = 0; i < slots; i++) {
    if (i < LIVE_FREE_PREFIX || i - lastLive > POSTS_BETWEEN_LIVES) {
      count += 1
      lastLive = i
    }
  }
  return count
}

interface PageBuild<T extends FeedCandidate> {
  readonly cards: RankedFeedItem<T>[]
  /** Posts consumed from the ordered post list (a prefix). */
  readonly postsTaken: number
}

/**
 * Assembles one page from the ordered posts and the `selectedLives` reserved for it. Lives that rule 2
 * cannot place are dropped; the caller (`buildPage`) hands their slots back to posts.
 */
function assemblePage<T extends FeedCandidate>(
  posts: readonly RankedFeedItem<T>[],
  selectedLives: readonly RankedFeedItem<T>[],
  pageSize: number,
): PageBuild<T> {
  // Largest arrangeable post prefix that fits next to the selected Lives.
  let postsTaken = Math.min(posts.length, pageSize - selectedLives.length)
  while (
    postsTaken > 0 &&
    !canArrangeAuthors(posts.slice(0, postsTaken).map((p) => p.candidate.authorHumanId))
  ) {
    postsTaken -= 1
  }

  const poolPosts = posts.slice(0, postsTaken)
  const poolLives = [...selectedLives]
  const cards: RankedFeedItem<T>[] = []
  let state: RunState = NO_RUN

  while (cards.length < pageSize && (poolPosts.length > 0 || poolLives.length > 0)) {
    let pickedPost = -1
    let pickedLive = -1
    let pi = 0
    let li = 0
    // Walk both pools in merged (score desc, id asc) order and take the first placeable item.
    while (pi < poolPosts.length || li < poolLives.length) {
      const post = poolPosts[pi]
      const live = poolLives[li]
      const takeLive = live !== undefined && (post === undefined || compareRanked(live, post) < 0)
      if (takeLive) {
        const roomForPosts = pageSize - cards.length - 1 >= poolPosts.length
        if (roomForPosts && liveAllowedAt(cards)) {
          pickedLive = li
          break
        }
        li += 1
      } else if (post !== undefined) {
        const author = post.candidate.authorHumanId
        if (!wouldExceedRun(state, author)) {
          const rest = poolPosts
            .filter((_, index) => index !== pi)
            .map((p) => p.candidate.authorHumanId)
          if (canArrangeAuthors(rest, advance(state, author))) {
            pickedPost = pi
            break
          }
        }
        pi += 1
      } else {
        break
      }
    }

    if (pickedLive >= 0) {
      const [live] = poolLives.splice(pickedLive, 1)
      if (live !== undefined) {
        cards.push(live)
        state = NO_RUN
      }
    } else if (pickedPost >= 0) {
      const [post] = poolPosts.splice(pickedPost, 1)
      if (post !== undefined) {
        cards.push(post)
        state = advance(state, post.candidate.authorHumanId)
      }
    } else {
      // Only unplaceable Lives remain (rule 2); they are dropped from this page.
      break
    }
  }

  return { cards, postsTaken }
}

function countLives<T extends FeedCandidate>(cards: readonly RankedFeedItem<T>[]): number {
  return cards.reduce((count, card) => count + (card.kind === 'live' ? 1 : 0), 0)
}

function buildPage<T extends FeedCandidate>(
  posts: readonly RankedFeedItem<T>[],
  lives: readonly RankedFeedItem<T>[],
  pageSize: number,
): PageBuild<T> {
  // Reserve at least one slot for posts so every page with posts advances the cursor.
  let liveBudget = Math.min(
    lives.length,
    maxLivesForSlots(pageSize),
    posts.length > 0 ? pageSize - 1 : pageSize,
  )
  // Rule 2 may leave low-ranked Lives unplaceable (their post separators are all used up). Every
  // slot reserved for such a Live is returned to posts and the page is rebuilt; the budget strictly
  // decreases so this ends after at most `maxLivesForSlots(pageSize)` rounds.
  for (;;) {
    const build = assemblePage(posts, lives.slice(0, liveBudget), pageSize)
    const placed = countLives(build.cards)
    const full = build.cards.length >= pageSize
    const postsExhausted = build.postsTaken >= posts.length
    if (placed >= liveBudget || full || postsExhausted) return build
    liveBudget = placed
  }
}

// ---------------------------------------------------------------------------
// rankFeed
// ---------------------------------------------------------------------------

/**
 * Scores, orders, diversifies and paginates `candidates` for one feed request. Deterministic:
 * the same candidates, scope, snapshot and cursor always produce the same page.
 */
export function rankFeed<T extends FeedCandidate>(
  candidates: readonly T[],
  options: RankFeedOptions,
): RankedFeedPage<T> {
  const pageSize = options.pageSize ?? FEED_PAGE_SIZE
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new EarthError('invalid_input', {
      details: { field: 'pageSize', reason: 'not_positive' },
    })
  }
  const areaId = options.areaId ?? null
  const cursorRaw = options.cursor ?? null
  const cursor =
    cursorRaw === null || cursorRaw.length === 0
      ? null
      : decodeCursor(cursorRaw, { scope: options.scope, areaId })
  const snapshotAt = cursor === null ? toIso(options.now) : cursor.snapshotAt

  const seen = new Set<string>()
  const scored: RankedFeedItem<T>[] = []
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue
    seen.add(candidate.id)
    const { score, components } = scoreCandidate(candidate, options.scope, snapshotAt)
    scored.push({ id: candidate.id, kind: candidate.kind, score, components, candidate })
  }
  scored.sort(compareRanked)

  const posts = scored.filter(
    (item) => item.kind === 'post' && (cursor === null || isAfterCursor(item, cursor)),
  )
  const lives = cursor === null ? scored.filter((item) => item.kind === 'live') : []

  const { cards, postsTaken } = buildPage(posts, lives, pageSize)

  const last = postsTaken > 0 ? posts[postsTaken - 1] : undefined
  const nextCursor =
    last !== undefined && postsTaken < posts.length
      ? encodeCursor({
          snapshotAt,
          lastScore: last.score,
          lastId: last.id,
          scope: options.scope,
          areaId,
        })
      : null

  return { cards, nextCursor, snapshotAt }
}
