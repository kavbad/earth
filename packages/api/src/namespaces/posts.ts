/**
 * `posts` (DB_API §4; spec §29–§31, SCREEN 06/07).
 */
import {
  type PostDetailDto,
  PostDetailDtoSchema,
  type PostDto,
  PostDtoSchema,
  type PostId,
  PostIdSchema,
  PostViewDtoSchema,
} from '@earth/domain'
import { z } from 'zod'

import {
  type PostCreateArgs,
  PostCreateArgsSchema,
  type PostReactionInput,
  PostReactionInputSchema,
  type PostRepliesInput,
  PostRepliesInputSchema,
  type PostRepliesPageDto,
  PostRepliesPageDtoSchema,
} from '../dto'
import { RPC } from '../rpc'
import { type Transport, parseInput } from '../transport'

export interface PostsNamespace {
  /**
   * `post_create(type, text, audience, area_id, place_id, media, reply_policy, reshare_policy,
   * parent_post_id)`. Neighborhood/city posts take their area from `human_context`; media items
   * reference objects registered through `media.upload`.
   */
  create(input: PostCreateArgs): Promise<PostDto>
  /** `post_get(post_id)`: post, author, media, reactions and the first page of replies. */
  get(postId: PostId): Promise<PostDetailDto>
  /** `post_delete(post_id)` (author): soft delete. */
  delete(postId: PostId): Promise<void>
  /** `post_reaction_set(post_id, reaction_type)`; `null` clears the viewer's reaction. */
  react(input: PostReactionInput): Promise<void>
  /** `post_hide(post_id)`: excluded from the viewer's feeds. */
  hide(postId: PostId): Promise<void>
  /** `post_replies(post_id, cursor, limit)`. */
  replies(input: PostRepliesInput): Promise<PostRepliesPageDto>
}

/** `post_create` returns `PostDto` (DB_API §4); a `PostViewDto` wrapper is unwrapped. */
const PostCreateResultSchema = z.union([
  PostDtoSchema,
  PostViewDtoSchema.transform((view) => view.post),
])

const PostRepliesResultSchema = z.union([
  PostRepliesPageDtoSchema,
  z
    .array(PostViewDtoSchema)
    .transform((replies): PostRepliesPageDto => ({ replies, nextCursor: null })),
])

export function createPostsNamespace(transport: Transport): PostsNamespace {
  return {
    create(input) {
      const parsed = parseInput(PostCreateArgsSchema, input)
      return transport.rpc(
        RPC.postCreate,
        {
          type: parsed.type,
          text: parsed.text,
          audience: parsed.audience,
          area_id: null,
          place_id: parsed.placeId,
          media: parsed.media.map((item) => item.mediaObjectId),
          reply_policy: parsed.replyPolicy,
          reshare_policy: parsed.resharePolicy,
          parent_post_id: parsed.parentPostId,
        },
        PostCreateResultSchema,
      )
    },
    get(postId) {
      const id = parseInput(PostIdSchema, postId, 'postId')
      return transport.rpc(RPC.postGet, { post_id: id }, PostDetailDtoSchema)
    },
    delete(postId) {
      const id = parseInput(PostIdSchema, postId, 'postId')
      return transport.rpcVoid(RPC.postDelete, { post_id: id })
    },
    react(input) {
      const parsed = parseInput(PostReactionInputSchema, input)
      return transport.rpcVoid(RPC.postReactionSet, {
        post_id: parsed.postId,
        reaction_type: parsed.reaction,
      })
    },
    hide(postId) {
      const id = parseInput(PostIdSchema, postId, 'postId')
      return transport.rpcVoid(RPC.postHide, { post_id: id })
    },
    replies(input) {
      const parsed = parseInput(PostRepliesInputSchema, input)
      return transport.rpc(
        RPC.postReplies,
        { post_id: parsed.postId, cursor: parsed.cursor ?? null, limit: parsed.limit ?? null },
        PostRepliesResultSchema,
      )
    },
  }
}
