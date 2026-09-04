/**
 * A profile's posts (SCREEN 22 "Now / posts"). The list comes from `posts_by_author` (DB_API §4,
 * 0996) through `earth.posts.byAuthor`, which answers full `PostViewDto`s; `useProfilePosts` no
 * longer reads the `posts` table. The row helpers below shape a bare `posts` row into a
 * `PostViewDto` (media and the viewer's reaction absent, fetched by `post_get` on demand) and stay
 * pure so the shaping is tested without a database.
 */
import {
  AudienceSchema,
  type HumanId,
  IsoDateTimeSchema,
  NonNegativeIntSchema,
  PostIdSchema,
  PostTypeSchema,
  type PostViewDto,
  type PublicIdentityDto,
  ReplyPolicySchema,
  ResharePolicySchema,
} from '@earth/domain'
import { z } from 'zod'

export const PROFILE_POSTS_TABLE = 'posts' as const
export const PROFILE_POSTS_LIMIT = 30
/** `parent_post_id is null` cannot be expressed with the transport's `eq` filter: fetch extra rows and drop replies. */
export const PROFILE_POSTS_FETCH_LIMIT = 60

export const PROFILE_POST_COLUMNS =
  'id, author_human_id, type, text, audience, area_id, place_id, reply_policy, reshare_policy, parent_post_id, root_post_id, created_at, edited_at, deleted_at, reaction_count, reply_count' as const

export const ProfilePostRowSchema = z.object({
  id: PostIdSchema,
  author_human_id: z.uuid(),
  type: PostTypeSchema,
  text: z.string().nullable(),
  audience: AudienceSchema,
  area_id: z.uuid().nullable(),
  place_id: z.uuid().nullable(),
  reply_policy: ReplyPolicySchema.catch('everyone_eligible'),
  reshare_policy: ResharePolicySchema.catch('allowed_within_audience'),
  parent_post_id: z.uuid().nullable(),
  root_post_id: z.uuid().nullable(),
  created_at: IsoDateTimeSchema,
  edited_at: IsoDateTimeSchema.nullable().catch(null),
  deleted_at: IsoDateTimeSchema.nullable().catch(null),
  reaction_count: NonNegativeIntSchema.catch(0),
  reply_count: NonNegativeIntSchema.catch(0),
})
export type ProfilePostRow = z.infer<typeof ProfilePostRowSchema>
export const ProfilePostRowsSchema = z.array(ProfilePostRowSchema)

/** Top-level, undeleted posts by the profile's Human, newest first, at most `limit`. */
export function selectProfilePosts(
  rows: readonly ProfilePostRow[],
  humanId: HumanId,
  limit: number = PROFILE_POSTS_LIMIT,
): ProfilePostRow[] {
  return rows
    .filter(
      (row) =>
        row.author_human_id === humanId && row.parent_post_id === null && row.deleted_at === null,
    )
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .slice(0, limit)
}

/** Shapes a row into what `PostCard` renders; media and the viewer's reaction arrive with `post_get`. */
export function postViewFromRow(row: ProfilePostRow, author: PublicIdentityDto): PostViewDto {
  return {
    post: {
      id: row.id,
      authorHumanId: author.humanId,
      type: row.type,
      text: row.text,
      audience: row.audience,
      areaId: row.area_id as PostViewDto['post']['areaId'],
      placeId: row.place_id as PostViewDto['post']['placeId'],
      replyPolicy: row.reply_policy,
      resharePolicy: row.reshare_policy,
      parentPostId: row.parent_post_id as PostViewDto['post']['parentPostId'],
      rootPostId: row.root_post_id as PostViewDto['post']['rootPostId'],
      createdAt: row.created_at,
      editedAt: row.edited_at,
      deletedAt: row.deleted_at,
    },
    author,
    reactionCount: row.reaction_count,
    replyCount: row.reply_count,
    myReaction: null,
    place: null,
    media: [],
  }
}

/** Media posts need `post_get` for their media URLs; text posts are complete from the row. */
export function needsDetail(view: PostViewDto): boolean {
  return view.post.type !== 'text' && view.media.length === 0
}
