import { z } from 'zod'

import { LOCATION_SHARE_MAX_MINUTES, LOCATION_SHARE_MIN_MINUTES } from '../constants'
import {
  AreaPrecisionSchema,
  AreaTypeSchema,
  LocationAudienceTypeSchema,
  LocationPrecisionSchema,
  PlaceVisibilitySchema,
} from '../enums'
import { AreaIdSchema, HumanIdSchema, PlaceIdSchema, PostIdSchema, RoomIdSchema } from '../ids'
import { DisplayNameSchema } from './claim'
import {
  IsoDateTimeSchema,
  LatLngDtoSchema,
  LatitudeSchema,
  LongitudeSchema,
  NonNegativeIntSchema,
  NullableUrlSchema,
} from './common'

/** `areas` (spec §37) without geometry. World is implicit and has no row. */
export const AreaDtoSchema = z.object({
  id: AreaIdSchema,
  type: AreaTypeSchema,
  name: z.string().min(1),
  parentAreaId: AreaIdSchema.nullable(),
  centroid: LatLngDtoSchema,
})
export type AreaDto = z.infer<typeof AreaDtoSchema>

/** `places` (spec §38). A public place, never a device coordinate. */
export const PlaceDtoSchema = z.object({
  id: PlaceIdSchema,
  name: z.string().min(1),
  areaId: AreaIdSchema,
  areaName: z.string().nullable(),
  lat: LatitudeSchema,
  lng: LongitudeSchema,
  category: z.string().nullable(),
  visibility: PlaceVisibilitySchema,
})
export type PlaceDto = z.infer<typeof PlaceDtoSchema>

/** `location_shares` (spec §39). Always time-bounded. */
export const LocationShareDtoSchema = z.object({
  id: z.uuid(),
  humanId: HumanIdSchema,
  audienceType: LocationAudienceTypeSchema,
  audienceId: z.uuid(),
  precision: LocationPrecisionSchema,
  expiresAt: IsoDateTimeSchema,
  createdAt: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
})
export type LocationShareDto = z.infer<typeof LocationShareDtoSchema>

/** spec §75: duration required — 1 hour, Tonight, custom short period. No "forever". */
export const LocationShareInputSchema = z.object({
  audienceType: LocationAudienceTypeSchema,
  audienceId: z.uuid(),
  precision: LocationPrecisionSchema,
  durationMinutes: z.int().min(LOCATION_SHARE_MIN_MINUTES).max(LOCATION_SHARE_MAX_MINUTES),
  /** Current device position, converted to area context server-side; only kept for `precise`/`approximate` shares. */
  position: LatLngDtoSchema,
})
export type LocationShareInput = z.infer<typeof LocationShareInputSchema>

export const MapLiveDtoSchema = z.object({
  roomId: RoomIdSchema,
  title: z.string().min(1),
  lat: LatitudeSchema,
  lng: LongitudeSchema,
  precision: AreaPrecisionSchema,
  participantCount: NonNegativeIntSchema,
})
export type MapLiveDto = z.infer<typeof MapLiveDtoSchema>

export const MapFriendDtoSchema = z.object({
  humanId: HumanIdSchema,
  displayName: DisplayNameSchema,
  avatarUrl: NullableUrlSchema,
  lat: LatitudeSchema,
  lng: LongitudeSchema,
  precision: LocationPrecisionSchema,
  expiresAt: IsoDateTimeSchema,
})
export type MapFriendDto = z.infer<typeof MapFriendDtoSchema>

export const MapMomentDtoSchema = z.object({
  postId: PostIdSchema,
  lat: LatitudeSchema,
  lng: LongitudeSchema,
  authorDisplayName: DisplayNameSchema,
})
export type MapMomentDto = z.infer<typeof MapMomentDtoSchema>

/** SCREEN 20 objects for a scope and bounding box. Coordinates are already precision-reduced. */
export const MapObjectsDtoSchema = z.object({
  lives: z.array(MapLiveDtoSchema),
  places: z.array(PlaceDtoSchema),
  friends: z.array(MapFriendDtoSchema),
  moments: z.array(MapMomentDtoSchema),
})
export type MapObjectsDto = z.infer<typeof MapObjectsDtoSchema>

/** The Human's current area context (spec §52/§74): current Neighborhood, current City, home City. */
export const HumanContextDtoSchema = z.object({
  currentAreaId: AreaIdSchema.nullable(),
  currentAreaName: z.string().nullable(),
  currentCityId: AreaIdSchema.nullable(),
  currentCityName: z.string().nullable(),
  homeCityId: AreaIdSchema.nullable(),
})
export type HumanContextDto = z.infer<typeof HumanContextDtoSchema>

/** `context_set_area`: explicit area ids (city switch) or a position to resolve. */
export const HumanContextSetInputSchema = z
  .object({
    currentAreaId: AreaIdSchema.nullish(),
    currentCityId: AreaIdSchema.nullish(),
    position: LatLngDtoSchema.nullish(),
  })
  .refine(
    (input) => input.position != null || input.currentAreaId != null || input.currentCityId != null,
    { message: 'provide an area id or a position' },
  )
export type HumanContextSetInput = z.infer<typeof HumanContextSetInputSchema>
