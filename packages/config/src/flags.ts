/**
 * Feature flags (spec §118, ARCHITECTURE §12).
 *
 * The database table `feature_flags(key, enabled, payload, updated_at)` is the runtime source;
 * this module owns the canonical key list, the launch defaults seeded by `0800_flags.sql`, and
 * the merge that turns rows into a complete {@link FeatureFlags} object.
 */
import { z } from 'zod'

/** Exactly the spec §118 list, in spec order. */
export const FEATURE_FLAG_KEYS = [
  'GROUP_ANCHORED_CLAIM_REQUIRED',
  'PUBLIC_WORLD_ENABLED',
  'PUBLIC_LIVE_ENABLED',
  'NEIGHBORHOOD_ENABLED',
  'CITY_ENABLED',
  'WORLD_ENABLED',
  'GUEST_ROOMS_ENABLED',
  'FRIENDS_LIVE_EXPANSION_ENABLED',
  'WORLD_LIVE_EXPANSION_ENABLED',
  'LOCATION_SHARING_ENABLED',
  'MAFIA_ACTIVITY_ENABLED',
] as const

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[number]

export const FeatureFlagKeySchema = z.enum(FEATURE_FLAG_KEYS)

/** Object form of {@link FEATURE_FLAG_KEYS} so call sites never spell a key as a string literal. */
export const FeatureFlag = FeatureFlagKeySchema.enum

export type FeatureFlags = Readonly<Record<FeatureFlagKey, boolean>>

/** Launch defaults (ARCHITECTURE §12). Also the value used when a row is missing. */
export const FEATURE_FLAG_DEFAULTS = {
  GROUP_ANCHORED_CLAIM_REQUIRED: true,
  PUBLIC_WORLD_ENABLED: true,
  PUBLIC_LIVE_ENABLED: true,
  NEIGHBORHOOD_ENABLED: true,
  CITY_ENABLED: true,
  WORLD_ENABLED: true,
  GUEST_ROOMS_ENABLED: true,
  FRIENDS_LIVE_EXPANSION_ENABLED: true,
  WORLD_LIVE_EXPANSION_ENABLED: true,
  LOCATION_SHARING_ENABLED: true,
  MAFIA_ACTIVITY_ENABLED: false,
} as const satisfies FeatureFlags

/**
 * The subset of a `feature_flags` row this package needs. `key` is deliberately any string:
 * the database may carry flags newer than this build, which {@link resolveFlags} ignores.
 */
export const FlagRowSchema = z.object({
  key: z.string().min(1),
  enabled: z.boolean(),
})
export type FlagRow = z.infer<typeof FlagRowSchema>

export const FlagRowsSchema = z.array(FlagRowSchema)

export function isFeatureFlagKey(key: string): key is FeatureFlagKey {
  return FeatureFlagKeySchema.safeParse(key).success
}

/**
 * Merges rows over {@link FEATURE_FLAG_DEFAULTS}: every known key is present in the result,
 * unknown keys are ignored, and when a key repeats the last row wins.
 */
export function resolveFlags(rows: readonly FlagRow[]): FeatureFlags {
  const flags: Record<FeatureFlagKey, boolean> = { ...FEATURE_FLAG_DEFAULTS }
  for (const row of rows) {
    if (isFeatureFlagKey(row.key)) flags[row.key] = row.enabled
  }
  return flags
}

/** Validates untrusted rows (for example an RPC result) before merging. */
export function resolveFlagsFrom(rows: unknown): FeatureFlags {
  return resolveFlags(FlagRowsSchema.parse(rows))
}
