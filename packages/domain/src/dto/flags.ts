import { z } from 'zod'

import { IsoDateTimeSchema, JsonObjectSchema } from './common'

/** Feature flag key format (`GROUP_ANCHORED_CLAIM_REQUIRED`, ...). The canonical key list lives in `@earth/config`. */
export const FeatureFlagKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/)
export type FeatureFlagKey = z.infer<typeof FeatureFlagKeySchema>

export const FlagValueDtoSchema = z.object({
  enabled: z.boolean(),
  payload: JsonObjectSchema.nullable(),
  updatedAt: IsoDateTimeSchema,
})
export type FlagValueDto = z.infer<typeof FlagValueDtoSchema>

/** `feature_flags` as read by everyone (ARCHITECTURE §12), keyed by flag key. */
export const FlagsDtoSchema = z.record(FeatureFlagKeySchema, FlagValueDtoSchema)
export type FlagsDto = z.infer<typeof FlagsDtoSchema>

/** Missing flags are treated as disabled. */
export function isFlagEnabled(flags: FlagsDto, key: FeatureFlagKey): boolean {
  return flags[key]?.enabled ?? false
}
