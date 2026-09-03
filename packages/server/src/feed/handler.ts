/**
 * `GET /api/feed` and `GET /api/live` (ARCHITECTURE §6, §9; spec PART IX, SCREEN 13).
 *
 * Feed: `feed_candidates(scope, area_id, snapshot_at, limit)` runs as the caller (the database
 * applies audience, blocks and membership), `rankFeed` from `@earth/domain` scores, diversifies
 * and paginates with the keyset cursor (never re-implemented here), and the page is rendered
 * into `FeedPageDto` with viewer-aware Live titles. Visitors may read `scope=world` only.
 *
 * Live: `live_candidates(scope, area_id, limit)` plus naming and the SCREEN 13 ordering
 * (`./live-order.ts`).
 */
import {
  EarthError,
  type FeedCardDto,
  type FeedPageDto,
  FeedPageDtoSchema,
  type LiveListDto,
  LiveListDtoSchema,
  type Scope,
  ScopeSchema,
  decodeCursor,
  rankFeed,
} from '@earth/domain'
import { z } from 'zod'

import type { ServerDeps } from '../deps'
import {
  type EarthRequest,
  type EarthResponse,
  ok,
  optionalBearer,
  parseInput,
  parseOutput,
  requestQuery,
  rpc,
} from '../http'
import { orderLiveRooms } from './live-order'
import {
  type FeedCandidateRow,
  FeedCandidatesResultSchema,
  LiveCandidatesResultSchema,
  candidateOf,
  liveCardFrom,
  postCardFrom,
} from './rows'

export const FEED_CANDIDATES_RPC = 'feed_candidates' as const
export const LIVE_CANDIDATES_RPC = 'live_candidates' as const
/** DB_API §4: `limit` default 200. */
export const FEED_CANDIDATE_LIMIT = 200
export const LIVE_CANDIDATE_LIMIT = 100
/** The only scope Visitors may browse (spec §43, §69). */
export const VISITOR_SCOPE: Scope = 'world'

export const FeedQuerySchema = z.object({
  scope: ScopeSchema.default(VISITOR_SCOPE),
  cursor: z.string().trim().min(1).optional(),
  areaId: z.uuid().optional(),
})
export type FeedQuery = z.infer<typeof FeedQuerySchema>

export const LiveQuerySchema = z.object({
  scope: ScopeSchema.default(VISITOR_SCOPE),
  areaId: z.uuid().optional(),
})
export type LiveQuery = z.infer<typeof LiveQuerySchema>

function queryValue(query: URLSearchParams, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = query.get(key)
    if (value !== null && value.trim() !== '') return value
  }
  return undefined
}

/** `?scope=&cursor=&area=` (`areaId` accepted as an alias of `area`). */
export function parseFeedQuery(req: EarthRequest): FeedQuery {
  const query = requestQuery(req)
  const raw: Record<string, string | undefined> = {
    scope: queryValue(query, 'scope'),
    cursor: queryValue(query, 'cursor'),
    areaId: queryValue(query, 'area', 'areaId'),
  }
  return parseInput(FeedQuerySchema, stripUndefined(raw), 'query')
}

export function parseLiveQuery(req: EarthRequest): LiveQuery {
  const query = requestQuery(req)
  const raw: Record<string, string | undefined> = {
    scope: queryValue(query, 'scope'),
    areaId: queryValue(query, 'area', 'areaId'),
  }
  return parseInput(LiveQuerySchema, stripUndefined(raw), 'query')
}

function stripUndefined(record: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/** Visitors (no bearer) may only browse World; every other scope needs a signed-in caller. */
export function assertScopeAllowed(accessToken: string | null, scope: Scope): void {
  if (accessToken === null && scope !== VISITOR_SCOPE) {
    throw new EarthError('not_authenticated', { details: { reason: 'visitor_scope', scope } })
  }
}

/** `GET /api/feed`. */
export async function handleFeed(deps: ServerDeps, req: EarthRequest): Promise<EarthResponse> {
  const query = parseFeedQuery(req)
  const accessToken = optionalBearer(req)
  assertScopeAllowed(accessToken, query.scope)
  const areaId = query.areaId ?? null
  const cursor = query.cursor ?? null
  const now = deps.now()
  // Later pages are pinned to the first page's snapshot so the candidate set (and scores) repeat.
  const snapshotAt =
    cursor === null
      ? now.toISOString()
      : decodeCursor(cursor, { scope: query.scope, areaId }).snapshotAt

  const result = await rpc(
    deps,
    accessToken,
    FEED_CANDIDATES_RPC,
    { scope: query.scope, area_id: areaId, snapshot_at: snapshotAt, limit: FEED_CANDIDATE_LIMIT },
    FeedCandidatesResultSchema,
  )
  const byId = new Map<string, FeedCandidateRow>()
  for (const row of result.rows) {
    if (!byId.has(row.id)) byId.set(row.id, row)
  }
  const candidates = [...byId.values()].map(candidateOf)
  const page = rankFeed(candidates, { scope: query.scope, now, cursor, areaId })

  const cards: FeedCardDto[] = []
  for (const item of page.cards) {
    const row = byId.get(item.id)
    if (row === undefined) continue
    if (item.kind === 'post') cards.push(postCardFrom(row))
    else if (row.live !== null && row.live !== undefined) cards.push(liveCardFrom(row.live))
  }

  const dto: FeedPageDto = parseOutput(
    FeedPageDtoSchema,
    {
      cards,
      nextCursor: page.nextCursor,
      snapshotAt: page.snapshotAt,
      scope: query.scope,
      areaName: result.areaName,
    },
    'FeedPageDto',
  )
  return ok(dto)
}

/** `GET /api/live`. */
export async function handleLive(deps: ServerDeps, req: EarthRequest): Promise<EarthResponse> {
  const query = parseLiveQuery(req)
  const accessToken = optionalBearer(req)
  assertScopeAllowed(accessToken, query.scope)
  const areaId = query.areaId ?? null

  const result = await rpc(
    deps,
    accessToken,
    LIVE_CANDIDATES_RPC,
    { scope: query.scope, area_id: areaId, limit: LIVE_CANDIDATE_LIMIT },
    LiveCandidatesResultSchema,
  )
  const ordered = orderLiveRooms(result.rows, query.scope)
  const dto: LiveListDto = parseOutput(
    LiveListDtoSchema,
    { cards: ordered.map(liveCardFrom), scope: query.scope, areaName: result.areaName },
    'LiveListDto',
  )
  return ok(dto)
}
