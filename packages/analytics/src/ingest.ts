/**
 * Wire format between the first-party provider and `POST /api/analytics/ingest`
 * (ARCHITECTURE §6). The server validates batches with these zod schemas, so everything the route
 * must refuse is refused here:
 *
 * - unknown event names (§97 is the whole contract);
 * - GPS coordinates by key or by value (§96; the guard from `./guard.ts` runs inside the schema);
 * - nested objects (properties are flat: scalars and arrays of scalars);
 * - keys that are not plain identifiers (`^[A-Za-z][A-Za-z0-9_]*$`, ≤ 64 chars) — this also keeps
 *   `__proto__`/`constructor` out of the parsed record;
 * - oversized payloads: ≤ 64 properties per event, strings ≤ 1024 chars, arrays ≤ 100 items,
 *   ≤ 100 events per batch;
 * - reserved §96 keys with the wrong shape when present: `humanId`/`guestSessionId` must be uuids,
 *   `anonymousVisitorId` a v4 uuid, `platform` one of `ANALYTICS_PLATFORMS`, `timestamp` an
 *   ISO-8601 instant, `appVersion` a non-empty string.
 */
import { z } from 'zod'

import { isUuid } from '@earth/domain'

import { EVENT_NAMES } from './contract'
import { findForbiddenPropertyKeys } from './guard'
import { ANALYTICS_PLATFORMS, isAnonymousVisitorId, type ReservedPropertyKey } from './identity'
import type { AnalyticsPropertyValue } from './provider'

export const ANALYTICS_INGEST_PATH = '/api/analytics/ingest' as const
export const ANALYTICS_INGEST_VERSION = 1 as const
/** Upper bound the route accepts per request. */
export const ANALYTICS_INGEST_MAX_EVENTS = 100
export const ANALYTICS_MAX_PROPERTIES_PER_EVENT = 64
export const ANALYTICS_MAX_PROPERTY_KEY_LENGTH = 64
export const ANALYTICS_MAX_STRING_LENGTH = 1024
export const ANALYTICS_MAX_ARRAY_LENGTH = 100

const PROPERTY_KEY_REGEX = /^[A-Za-z][A-Za-z0-9_]*$/

export const AnalyticsPropertyKeySchema = z
  .string()
  .max(ANALYTICS_MAX_PROPERTY_KEY_LENGTH)
  .regex(PROPERTY_KEY_REGEX, 'analytics property keys are plain identifiers')

const BoundedStringSchema = z.string().max(ANALYTICS_MAX_STRING_LENGTH)

export const AnalyticsScalarSchema = z.union([
  BoundedStringSchema,
  z.number(),
  z.boolean(),
  z.null(),
])
export const AnalyticsPropertyValueSchema = z.union([
  AnalyticsScalarSchema,
  z.array(z.union([BoundedStringSchema, z.number(), z.boolean()])).max(ANALYTICS_MAX_ARRAY_LENGTH),
])

const IsoInstantSchema = z.iso.datetime({ offset: true })

/** Shape each reserved key must have when a batch carries it (absence is always fine). */
const RESERVED_PROPERTY_VALIDATORS: Readonly<
  Record<ReservedPropertyKey, (value: unknown) => boolean>
> = {
  humanId: isUuid,
  guestSessionId: isUuid,
  anonymousVisitorId: isAnonymousVisitorId,
  appVersion: (value) => typeof value === 'string' && value.length > 0,
  platform: (value) =>
    typeof value === 'string' && (ANALYTICS_PLATFORMS as readonly string[]).includes(value),
  timestamp: (value) => IsoInstantSchema.safeParse(value).success,
}

const RESERVED_VALIDATOR_ENTRIES = Object.entries(RESERVED_PROPERTY_VALIDATORS) as [
  ReservedPropertyKey,
  (value: unknown) => boolean,
][]

/** Reserved keys present in `properties` whose value has the wrong shape, in key order. */
export function invalidReservedProperties(
  properties: Readonly<Record<string, unknown>>,
): ReservedPropertyKey[] {
  const invalid: ReservedPropertyKey[] = []
  for (const [key, validate] of RESERVED_VALIDATOR_ENTRIES) {
    const value = properties[key]
    if (value !== undefined && !validate(value)) invalid.push(key)
  }
  return invalid
}

export const AnalyticsPropertiesSchema = z
  .record(AnalyticsPropertyKeySchema, AnalyticsPropertyValueSchema)
  .superRefine((properties, ctx) => {
    const keyCount = Object.keys(properties).length
    if (keyCount > ANALYTICS_MAX_PROPERTIES_PER_EVENT) {
      ctx.addIssue({
        code: 'custom',
        message: `analytics events carry at most ${ANALYTICS_MAX_PROPERTIES_PER_EVENT} properties (got ${keyCount})`,
      })
    }
    const forbidden = findForbiddenPropertyKeys(properties)
    if (forbidden.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: `analytics properties must not carry GPS coordinates: ${forbidden.join(', ')}`,
      })
    }
    for (const key of invalidReservedProperties(properties)) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `analytics reserved property "${key}" has the wrong shape`,
      })
    }
  })

export const AnalyticsEnvelopeSchema = z.object({
  name: z.enum(EVENT_NAMES),
  properties: AnalyticsPropertiesSchema,
})
export type AnalyticsEnvelope = z.infer<typeof AnalyticsEnvelopeSchema>

export const AnalyticsIngestBatchSchema = z.object({
  v: z.literal(ANALYTICS_INGEST_VERSION),
  /** ISO-8601 instant the batch left the device (server computes clock skew from it). */
  sentAt: IsoInstantSchema,
  events: z.array(AnalyticsEnvelopeSchema).min(1).max(ANALYTICS_INGEST_MAX_EVENTS),
})
export type AnalyticsIngestBatch = z.infer<typeof AnalyticsIngestBatchSchema>

/** Drops `undefined` values so merged client properties fit the wire type. */
export function wireProperties(
  properties: Readonly<Record<string, AnalyticsPropertyValue>>,
): AnalyticsEnvelope['properties'] {
  const out: Record<string, AnalyticsPropertyValue> = {}
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined) out[key] = value
  }
  return out as AnalyticsEnvelope['properties']
}

export function ingestUrl(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/+$/, '') + ANALYTICS_INGEST_PATH
}
