/**
 * Audience integrity for reshares (spec §72: "Allowed reshare audience must be equal to or narrower
 * than source audience"; spec §29 `reshare_policy`). Uses the ordering of `@earth/domain/audience`.
 */
import { AUDIENCE, isAudienceWithin, type Audience, type ResharePolicy } from '@earth/domain'

/**
 * Audiences a reshare of a post with `sourceAudience` may target, narrow → wide. Empty when the
 * author disallowed reshares.
 */
export function allowedReshareAudiences(
  sourceAudience: Audience,
  resharePolicy: ResharePolicy = 'allowed_within_audience',
): readonly Audience[] {
  if (resharePolicy === 'none') return []
  return AUDIENCE.filter((audience) => isAudienceWithin(audience, sourceAudience))
}

/** Whether a reshare to `targetAudience` keeps within the source (spec §72). */
export function canReshareTo(
  sourceAudience: Audience,
  targetAudience: Audience,
  resharePolicy: ResharePolicy = 'allowed_within_audience',
): boolean {
  return allowedReshareAudiences(sourceAudience, resharePolicy).includes(targetAudience)
}
