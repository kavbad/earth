/**
 * Building blocks shared by every DTO schema.
 */
import { z } from 'zod'

/** ISO 8601 with offset (`2026-09-03T06:00:00.123456+00:00` from `to_jsonb(timestamptz)`, or `Z`). */
export const IsoDateTimeSchema = z.iso.datetime({ offset: true })
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>

export const JsonValueSchema = z.json()
export type JsonValue = z.infer<typeof JsonValueSchema>

export const JsonObjectSchema = z.record(z.string(), z.json())
export type JsonObject = z.infer<typeof JsonObjectSchema>

/** Absolute http(s) URL (storage public URLs, signed URLs, deep links). */
export const UrlSchema = z.url({ protocol: /^https?$/ })

export const NullableUrlSchema = UrlSchema.nullable()

export const NonNegativeIntSchema = z.int().min(0)
export const PositiveIntSchema = z.int().min(1)

/** Opaque keyset cursor; `null` means no further page. */
export const CursorSchema = z.string().min(1)
export const NullableCursorSchema = CursorSchema.nullable()

export const LatitudeSchema = z.number().min(-90).max(90)
export const LongitudeSchema = z.number().min(-180).max(180)

export const LatLngDtoSchema = z.object({
  lat: LatitudeSchema,
  lng: LongitudeSchema,
})
export type LatLngDto = z.infer<typeof LatLngDtoSchema>

/** `[west, south, east, north]` in degrees. */
export const BoundingBoxSchema = z
  .tuple([LongitudeSchema, LatitudeSchema, LongitudeSchema, LatitudeSchema])
  .refine(([west, south, east, north]) => west <= east && south <= north, {
    message: 'bounding box must be [west, south, east, north] with west <= east and south <= north',
  })
export type BoundingBox = z.infer<typeof BoundingBoxSchema>

/** A trimmed, non-empty string. */
export const NonEmptyTrimmedString = z.string().trim().min(1)
