import { z } from 'zod'

import { SEARCH_QUERY_MAX } from '../constants'
import { GroupIdSchema, HumanIdSchema, PlaceIdSchema } from '../ids'
import { DisplayNameSchema, HandleSchema } from './claim'
import { LatitudeSchema, LongitudeSchema, NonNegativeIntSchema, NullableUrlSchema } from './common'
import { GroupNameSchema } from './groups'
import { PostViewDtoSchema } from './posts'

/** "Xavier — 8 mutual friends · San Francisco" (SCREEN 21). */
export const SearchPersonDtoSchema = z.object({
  humanId: HumanIdSchema,
  displayName: DisplayNameSchema,
  handle: HandleSchema,
  avatarUrl: NullableUrlSchema,
  mutualFriendCount: NonNegativeIntSchema,
  cityName: z.string().nullable(),
  isFriend: z.boolean(),
  isFollowing: z.boolean(),
})
export type SearchPersonDto = z.infer<typeof SearchPersonDtoSchema>

export const SearchGroupDtoSchema = z.object({
  groupId: GroupIdSchema,
  name: GroupNameSchema.nullable(),
  avatarUrl: NullableUrlSchema,
  memberCount: NonNegativeIntSchema,
  isMember: z.boolean(),
})
export type SearchGroupDto = z.infer<typeof SearchGroupDtoSchema>

export const SearchPlaceDtoSchema = z.object({
  placeId: PlaceIdSchema,
  name: z.string().min(1),
  areaName: z.string().nullable(),
  lat: LatitudeSchema,
  lng: LongitudeSchema,
  category: z.string().nullable(),
})
export type SearchPlaceDto = z.infer<typeof SearchPlaceDtoSchema>

export const SearchResultsDtoSchema = z.object({
  people: z.array(SearchPersonDtoSchema),
  groups: z.array(SearchGroupDtoSchema),
  places: z.array(SearchPlaceDtoSchema),
  posts: z.array(PostViewDtoSchema),
})
export type SearchResultsDto = z.infer<typeof SearchResultsDtoSchema>

export const SearchInputSchema = z.object({
  q: z.string().trim().min(1).max(SEARCH_QUERY_MAX),
})
export type SearchInput = z.infer<typeof SearchInputSchema>
