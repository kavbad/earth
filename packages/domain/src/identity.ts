/**
 * Reserved identity kinds (spec §134). Only `human` exists in V1; `page` reserves the type and the
 * table abstraction for organizations later. No page tooling ships in V1.
 */

export const IDENTITY_KINDS = ['human', 'page'] as const
export type IdentityKind = (typeof IDENTITY_KINDS)[number]

/** The single identity kind that exists in V1. */
export const V1_IDENTITY_KIND: IdentityKind = 'human'

export function isV1IdentityKind(kind: IdentityKind): kind is 'human' {
  return kind === V1_IDENTITY_KIND
}
