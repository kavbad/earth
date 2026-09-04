import { z } from 'zod'

import { POST_TEXT_MAX } from '../constants'
import {
  AudienceSchema,
  MediaProvenanceSchema,
  MediaTypeSchema,
  PostTypeSchema,
  ReplyPolicySchema,
  ResharePolicySchema,
} from '../enums'
import { AreaIdSchema, HumanIdSchema, PlaceIdSchema, PostIdSchema } from '../ids'
import { IsoDateTimeSchema, NonNegativeIntSchema, UrlSchema } from './common'
import { PlaceDtoSchema } from './geo'
import { PublicIdentityDtoSchema } from './identity'

export const PostTextSchema = z.string().max(POST_TEXT_MAX)

/** `post_media` (spec §30) with a resolved (signed or public) URL. */
export const PostMediaDtoSchema = z.object({
  id: z.uuid(),
  postId: PostIdSchema,
  mediaType: MediaTypeSchema,
  url: UrlSchema,
  width: NonNegativeIntSchema,
  height: NonNegativeIntSchema,
  durationMs: NonNegativeIntSchema.nullable(),
  provenance: MediaProvenanceSchema,
})
export type PostMediaDto = z.infer<typeof PostMediaDtoSchema>

/** `posts` (spec §29). `audience` is who the author intended to reach. */
export const PostDtoSchema = z.object({
  id: PostIdSchema,
  authorHumanId: HumanIdSchema,
  type: PostTypeSchema,
  text: PostTextSchema.nullable(),
  audience: AudienceSchema,
  areaId: AreaIdSchema.nullable(),
  placeId: PlaceIdSchema.nullable(),
  replyPolicy: ReplyPolicySchema,
  resharePolicy: ResharePolicySchema,
  parentPostId: PostIdSchema.nullable(),
  rootPostId: PostIdSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  editedAt: IsoDateTimeSchema.nullable(),
  deletedAt: IsoDateTimeSchema.nullable(),
})
export type PostDto = z.infer<typeof PostDtoSchema>

/** A post as rendered anywhere: row + author + counts + viewer state + place + media. */
export const PostViewDtoSchema = z.object({
  post: PostDtoSchema,
  author: PublicIdentityDtoSchema,
  reactionCount: NonNegativeIntSchema,
  replyCount: NonNegativeIntSchema,
  myReaction: z.string().min(1).nullable(),
  place: PlaceDtoSchema.nullable(),
  media: z.array(PostMediaDtoSchema),
})
export type PostViewDto = z.infer<typeof PostViewDtoSchema>

/** SCREEN 07: the post plus its visible replies (replies never widen the root audience). */
export const PostDetailDtoSchema = PostViewDtoSchema.extend({
  replies: z.array(PostViewDtoSchema),
})
export type PostDetailDto = z.infer<typeof PostDetailDtoSchema>

export const PostMediaInputSchema = z.object({
  /** Storage object key in the `media` bucket, uploaded before `post_create`. */
  storageKey: z.string().min(1),
  mediaType: MediaTypeSchema,
  width: NonNegativeIntSchema,
  height: NonNegativeIntSchema,
  durationMs: NonNegativeIntSchema.nullable(),
  provenance: MediaProvenanceSchema,
})
export type PostMediaInput = z.infer<typeof PostMediaInputSchema>

/** SCREEN 06: at least one of text or media; place tag explicit; no GPS. */
export const PostCreateInputSchema = z
  .object({
    type: PostTypeSchema,
    text: PostTextSchema.nullable(),
    audience: AudienceSchema,
    placeId: PlaceIdSchema.nullable(),
    media: z.array(PostMediaInputSchema).max(10),
    replyPolicy: ReplyPolicySchema.default('everyone_eligible'),
    resharePolicy: ResharePolicySchema.default('allowed_within_audience'),
    /** Set when the post is a reply; audience must be within the root's audience. */
    parentPostId: PostIdSchema.nullable(),
    /** Client-generated id for idempotent creation. */
    clientId: z.uuid().nullish(),
  })
  .refine(
    (input) => (input.text !== null && input.text.trim().length > 0) || input.media.length > 0,
    { message: 'a post needs text or media', path: ['text'] },
  )
export type PostCreateInput = z.infer<typeof PostCreateInputSchema>

export const PostReactInputSchema = z.object({
  postId: PostIdSchema,
  reaction: z.string().min(1).max(16),
})
export type PostReactInput = z.infer<typeof PostReactInputSchema>
