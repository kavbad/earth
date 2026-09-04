/**
 * `posts` (DB_API §4; spec §29–§31, SCREEN 06/07).
 */
import { type PostDetailDto, type PostDto, type PostId, PostIdSchema } from '@earth/domain'

import {
  type PostCreateArgs,
  PostCreateArgsSchema,
  type PostReactionDto,
  type PostReactionInput,
  PostReactionInputSchema,
  type PostRepliesInput,
  PostRepliesInputSchema,
  type PostRepliesPageDto,
  PostsByAuthorInputSchema,
  type PostsByAuthorPageDto,
} from '../dto'
import { CALLS } from '../manifest'
import { type Transport, parseInput } from '../transport'

export interface PostsNamespace {
  /**
   * `post_create(type, text, audience, area_id, place_id, media, reply_policy, reshare_policy,
   * parent_post_id, provenance)`. Neighborhood/city posts take their area from `human_context`;
   * media items reference objects registered through `media.upload`, `provenance[i]` labels
   * `media[i]`. The RPC answers a `PostViewDto`; this returns its `post`.
   */
  create(input: PostCreateArgs): Promise<PostDto>
  /** `post_get(post_id)`: post, author, media, reactions and the first page of replies. */
  get(postId: PostId): Promise<PostDetailDto>
  /** `post_delete(post_id)` (author): soft delete. */
  delete(postId: PostId): Promise<void>
  /** `post_reaction_set(post_id, reaction_type)`; `null` clears the viewer's reaction. */
  react(input: PostReactionInput): Promise<PostReactionDto>
  /** `post_hide(post_id)`: excluded from the viewer's feeds. */
  hide(postId: PostId): Promise<void>
  /** `post_replies(post_id, cursor, limit)`. */
  replies(input: PostRepliesInput): Promise<PostRepliesPageDto>
  /**
   * `posts_by_author(handle, cursor, limit)` (SCREEN 22 "Now"): the author's root posts the caller
   * may see, newest first; `@Maya` / `MAYA` look up `maya`. `cursor` is the previous page's
   * `nextCursor`; `not_visible` when the profile is not visible to the caller.
   */
  byAuthor(
    handle: string,
    cursor?: string | null,
    limit?: number | null,
  ): Promise<PostsByAuthorPageDto>
}

export function createPostsNamespace(transport: Transport): PostsNamespace {
  return {
    create(input) {
      const parsed = parseInput(PostCreateArgsSchema, input)
      return transport.call(CALLS.postsCreate, {
        type: parsed.type,
        text: parsed.text,
        audience: parsed.audience,
        area_id: null,
        place_id: parsed.placeId,
        media: parsed.media.map((item) => item.mediaObjectId),
        reply_policy: parsed.replyPolicy,
        reshare_policy: parsed.resharePolicy,
        parent_post_id: parsed.parentPostId,
        provenance: parsed.media.map((item) => item.provenance),
      })
    },
    get(postId) {
      const id = parseInput(PostIdSchema, postId, 'postId')
      return transport.call(CALLS.postsGet, { post_id: id })
    },
    delete(postId) {
      const id = parseInput(PostIdSchema, postId, 'postId')
      return transport.call(CALLS.postsDelete, { post_id: id })
    },
    react(input) {
      const parsed = parseInput(PostReactionInputSchema, input)
      return transport.call(CALLS.postsReact, {
        post_id: parsed.postId,
        reaction_type: parsed.reaction,
      })
    },
    hide(postId) {
      const id = parseInput(PostIdSchema, postId, 'postId')
      return transport.call(CALLS.postsHide, { post_id: id })
    },
    replies(input) {
      const parsed = parseInput(PostRepliesInputSchema, input)
      return transport.call(CALLS.postsReplies, {
        post_id: parsed.postId,
        cursor: parsed.cursor ?? null,
        limit: parsed.limit ?? null,
      })
    },
    byAuthor(handle, cursor = null, limit = null) {
      const parsed = parseInput(PostsByAuthorInputSchema, { handle, cursor, limit })
      return transport.call(CALLS.postsByAuthor, {
        handle: parsed.handle,
        cursor: parsed.cursor ?? null,
        limit: parsed.limit ?? null,
      })
    },
  }
}
