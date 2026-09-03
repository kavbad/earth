/**
 * Shared fixtures for the posts / feed database tests (Milestone 5). Posts go through the RPCs of
 * 0430; Humans, edges, areas, context and media objects are raw rows for speed. Re-exports the
 * admission and rooms fixtures these tests build on.
 */
import {
  FeedCandidateSchema,
  PostDetailDtoSchema,
  PostViewDtoSchema,
  type PostDetailDto,
  type PostViewDto,
} from '@earth/domain'
import { z } from 'zod'

import type { RoleSpec, TestDb } from '../harness'
import type { Human } from '../admission/fixtures'

export {
  addMember,
  befriend,
  block,
  count,
  createArea,
  createGroup,
  createGuest,
  createHuman,
  createUnclaimed,
  relate,
  scalar,
  setFlag,
  setSetting,
  type GroupFixture,
  type Human,
} from '../admission/fixtures'
export {
  human,
  joinRoom,
  rpcAt,
  setContext,
  startGroupRoom,
  startStandaloneRoom,
} from '../rooms/fixtures'

export const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/** The live rendering payload (`live_candidates` item) as the server tier reads it. */
export const LivePayloadSchema = z.object({
  roomId: z.uuid(),
  contextType: z.string(),
  contextTitle: z.string().nullable(),
  title: z.string().nullable(),
  visibility: z.string(),
  startedAt: z.iso.datetime({ offset: true }),
  areaName: z.string().nullable(),
  participantCount: z.int().min(0),
  participants: z.array(
    z.object({
      id: z.uuid(),
      humanId: z.uuid().nullable(),
      displayName: z.string().min(1),
      mediaState: z.string(),
      relationToViewer: z.string().nullable(),
    }),
  ),
})

/** One `feed_candidates` row: the ranking features plus its rendering payload (DB_API §4). */
export const FeedRowSchema = z
  .object({
    ...FeedCandidateSchema.shape,
    post: PostViewDtoSchema.nullish(),
    live: LivePayloadSchema.nullish(),
  })
  .superRefine((row, ctx) => {
    if (row.kind === 'post' && row.post == null)
      ctx.addIssue({ code: 'custom', message: 'post payload missing' })
    if (row.kind === 'live' && row.live == null)
      ctx.addIssue({ code: 'custom', message: 'live payload missing' })
  })
export type FeedRow = z.infer<typeof FeedRowSchema>

export const FeedResultSchema = z.object({
  candidates: z.array(FeedRowSchema),
  scope: z.string(),
  areaId: z.uuid().nullable(),
  areaName: z.string().nullable(),
  snapshotAt: z.iso.datetime({ offset: true }),
})
export type FeedResult = z.infer<typeof FeedResultSchema>

export const PublicFeedResultSchema = z.object({
  candidates: z.array(FeedRowSchema),
  nextCursor: z.iso.datetime({ offset: true }).nullable(),
  snapshotAt: z.iso.datetime({ offset: true }),
  scope: z.literal('world'),
})

export const RepliesPageSchema = z.object({
  replies: z.array(PostViewDtoSchema),
  nextCursor: z.uuid().nullable(),
})

export interface CreatePostOptions {
  type?: 'text' | 'image' | 'video' | 'moment'
  text?: string | null
  audience?: 'friends' | 'neighborhood' | 'city' | 'world'
  areaId?: string | null
  placeId?: string | null
  media?: string[]
  replyPolicy?: 'everyone_eligible' | 'friends' | 'mentioned' | 'none'
  resharePolicy?: 'allowed_within_audience' | 'none'
  parentPostId?: string | null
  provenance?: string[] | null
}

export function postArgs(options: CreatePostOptions): Record<string, unknown> {
  return {
    type: options.type ?? 'text',
    text: options.text === undefined ? 'hello' : options.text,
    audience: options.audience ?? 'friends',
    area_id: options.areaId ?? null,
    place_id: options.placeId ?? null,
    media: options.media ?? [],
    reply_policy: options.replyPolicy ?? 'everyone_eligible',
    reshare_policy: options.resharePolicy ?? 'allowed_within_audience',
    parent_post_id: options.parentPostId ?? null,
    provenance: options.provenance ?? null,
  }
}

/** `post_create` as `author`, parsed as `PostViewDto`. */
export async function createPost(
  db: TestDb,
  author: Human,
  options: CreatePostOptions = {},
): Promise<PostViewDto> {
  return PostViewDtoSchema.parse(await db.rpc('post_create', postArgs(options), author.as))
}

export async function getPost(db: TestDb, postId: string, as: RoleSpec): Promise<PostDetailDto> {
  return PostDetailDtoSchema.parse(await db.rpc('post_get', { post_id: postId }, as))
}

/** True when `post_get` succeeds for the caller, false on `post_not_found`. */
export async function canSee(db: TestDb, postId: string, as: RoleSpec): Promise<boolean> {
  try {
    await db.rpc('post_get', { post_id: postId }, as)
    return true
  } catch (error) {
    if (error instanceof Error && error.message === 'post_not_found') return false
    throw error
  }
}

export async function feed(
  db: TestDb,
  scope: string,
  as: RoleSpec,
  options: { areaId?: string | null; snapshotAt?: string | null; limit?: number | null } = {},
): Promise<FeedResult> {
  return FeedResultSchema.parse(
    await db.rpc(
      'feed_candidates',
      {
        scope,
        area_id: options.areaId ?? null,
        snapshot_at: options.snapshotAt ?? null,
        limit: options.limit ?? null,
      },
      as,
    ),
  )
}

export async function feedIds(
  db: TestDb,
  scope: string,
  as: RoleSpec,
  options: { areaId?: string | null; snapshotAt?: string | null; limit?: number | null } = {},
): Promise<string[]> {
  return (await feed(db, scope, as, options)).candidates.map((c) => c.id).sort()
}

/** A media object owned by `owner` in the given bucket. */
export async function createMedia(
  db: TestDb,
  owner: Human,
  options: {
    key?: string
    contentType?: string
    bucket?: 'media' | 'avatars' | 'voice'
    width?: number | null
    height?: number | null
    durationMs?: number | null
  } = {},
): Promise<string> {
  mediaCounter += 1
  const { rows } = await db.sql.query<{ id: string }>(
    `insert into public.media_objects (owner_human_id, bucket, storage_key, content_type, width, height, duration_ms)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      owner.humanId,
      options.bucket ?? 'media',
      options.key ?? `${owner.handle}/m${mediaCounter}.jpg`,
      options.contentType ?? 'image/jpeg',
      options.width === undefined ? 640 : options.width,
      options.height === undefined ? 480 : options.height,
      options.durationMs ?? null,
    ],
  )
  const id = rows[0]?.id
  if (id === undefined) throw new Error('media_objects insert returned no id')
  return id
}
let mediaCounter = 0

export async function createPlace(
  db: TestDb,
  areaId: string,
  name = 'Dolores Park',
  visibility: 'public' | 'private' = 'public',
): Promise<string> {
  const { rows } = await db.sql.query<{ id: string }>(
    `insert into public.places (name, area_id, location, visibility, category)
     values ($1, $2, st_setsrid(st_makepoint(-122.427, 37.7596), 4326), $3, 'park') returning id`,
    [name, areaId, visibility],
  )
  const id = rows[0]?.id
  if (id === undefined) throw new Error('places insert returned no id')
  return id
}

export async function postRow(
  db: TestDb,
  postId: string,
): Promise<{
  status: string
  audience: string
  area_id: string | null
  root_post_id: string | null
  reply_count: number
  reaction_count: number
  text: string | null
  deleted_at: string | null
}> {
  const { rows } = await db.sql.query(
    `select status, audience::text, area_id, root_post_id, reply_count, reaction_count, text, deleted_at from public.posts where id = $1`,
    [postId],
  )
  const row = rows[0]
  if (row === undefined) throw new Error('post missing')
  return row as Awaited<ReturnType<typeof postRow>>
}

/** Clears every rate-limit window (each test file owns its scratch database). */
export async function resetRateLimits(db: TestDb): Promise<void> {
  await db.sql.query('delete from private.rate_limits')
}

/** Sets `humans.is_fixture` / status directly. */
export async function setHuman(
  db: TestDb,
  human: Human,
  patch: { isFixture?: boolean; status?: string },
): Promise<void> {
  if (patch.isFixture !== undefined) {
    await db.sql.query('update public.humans set is_fixture = $2 where id = $1', [
      human.humanId,
      patch.isFixture,
    ])
  }
  if (patch.status !== undefined) {
    await db.sql.query('update public.humans set status = $2::public.human_status where id = $1', [
      human.humanId,
      patch.status,
    ])
  }
}
