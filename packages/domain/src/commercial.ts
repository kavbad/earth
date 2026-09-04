/**
 * Reserved monetization types (spec §135). Unused in V1: there are no ads, no sponsored objects and
 * no commercial surfaces. They exist so future schema and DTO work has a named shape to extend
 * without touching the Human, Group or Room models.
 */

/** Kinds of objects that could carry commercial metadata later. */
export const COMMERCIAL_OBJECT_KINDS = ['post', 'room', 'place', 'page'] as const
export type CommercialObjectKind = (typeof COMMERCIAL_OBJECT_KINDS)[number]

/** Reserved. Not persisted and not rendered in V1. */
export interface SponsorshipMetadata {
  sponsorName: string
  disclosureText: string
  /** ISO 8601. */
  startsAt: string
  /** ISO 8601, `null` = open-ended. */
  endsAt: string | null
}

/** Reserved. Not persisted and not rendered in V1. */
export interface CommercialObject {
  id: string
  kind: CommercialObjectKind
  objectId: string
  sponsorship: SponsorshipMetadata | null
}
