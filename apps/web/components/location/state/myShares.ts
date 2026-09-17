/**
 * The Human's own active shares, remembered on this device: the server lists only shares that
 * reach the viewer (`location_shares_visible`), so what *I* am sharing is kept here until it
 * expires or is revoked. Pure over `KeyValueStorage` so it is tested without a browser.
 */
import { LocationAudienceTypeSchema, LocationPrecisionSchema } from '@earth/domain'
import { z } from 'zod'

import { type KeyValueStorage, readJson, writeJson } from '../../../lib/storage'

export const MY_SHARES_STORAGE_PREFIX = 'earth.location.shares' as const

export const MyShareSchema = z.object({
  id: z.uuid(),
  audienceType: LocationAudienceTypeSchema,
  audienceId: z.uuid(),
  audienceName: z.string().min(1),
  precision: LocationPrecisionSchema,
  expiresAt: z.iso.datetime({ offset: true }),
  createdAt: z.iso.datetime({ offset: true }),
})
export type MyShare = z.infer<typeof MyShareSchema>

const MySharesSchema = z.array(MyShareSchema)

export function mySharesKey(humanId: string): string {
  return `${MY_SHARES_STORAGE_PREFIX}.${humanId}`
}

export function isShareActive(share: MyShare, now: number): boolean {
  return new Date(share.expiresAt).getTime() > now
}

/** Active shares only, newest first. Malformed storage reads as none. */
export function readMyShares(
  storage: KeyValueStorage | null,
  humanId: string,
  now: number,
): MyShare[] {
  const stored = readJson(storage, mySharesKey(humanId), (value) => {
    const parsed = MySharesSchema.safeParse(value)
    return parsed.success ? parsed.data : null
  })
  return (stored ?? [])
    .filter((share) => isShareActive(share, now))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export function writeMyShares(
  storage: KeyValueStorage | null,
  humanId: string,
  shares: readonly MyShare[],
): void {
  writeJson(storage, mySharesKey(humanId), shares)
}

/** A new share to the same audience replaces the old one (the server revokes it too). */
export function addMyShare(shares: readonly MyShare[], share: MyShare): MyShare[] {
  return [
    share,
    ...shares.filter(
      (s) => !(s.audienceType === share.audienceType && s.audienceId === share.audienceId),
    ),
  ]
}

export function removeMyShare(shares: readonly MyShare[], shareId: string): MyShare[] {
  return shares.filter((share) => share.id !== shareId)
}

/** Shares whose position the device should keep fresh: `city` never carries a position. */
export function sharesNeedingUpdates(shares: readonly MyShare[], now: number): MyShare[] {
  return shares.filter((share) => share.precision !== 'city' && isShareActive(share, now))
}
