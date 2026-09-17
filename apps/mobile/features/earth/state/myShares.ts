/**
 * The Human's own active shares, remembered on this device: the server lists only shares that
 * reach the viewer (`location_shares_visible`), so what *I* am sharing is kept here until it
 * expires or is revoked. Pure over the parsed list; the device store is read/written through
 * `KeyValueStorage` so it is tested without a phone.
 */
import { LocationAudienceTypeSchema, LocationPrecisionSchema } from '@earth/domain'
import { z } from 'zod'

import { type KeyValueStorage, readJson, writeJson } from '../storage'

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

/** Active shares only, newest first. */
export function selectActiveShares(shares: readonly MyShare[], now: number): MyShare[] {
  return shares
    .filter((share) => isShareActive(share, now))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Parses whatever the device remembered; malformed storage reads as none. */
export function parseMyShares(value: unknown): MyShare[] | null {
  const parsed = MySharesSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export async function readMyShares(
  storage: KeyValueStorage | null,
  humanId: string,
  now: number,
): Promise<MyShare[]> {
  const stored = await readJson(storage, mySharesKey(humanId), parseMyShares)
  return selectActiveShares(stored ?? [], now)
}

export function writeMyShares(
  storage: KeyValueStorage | null,
  humanId: string,
  shares: readonly MyShare[],
): Promise<void> {
  return writeJson(storage, mySharesKey(humanId), shares)
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

/** The soonest expiry among active shares, or `null`: when the updater re-evaluates on its own. */
export function nextExpiry(shares: readonly MyShare[], now: number): number | null {
  let soonest: number | null = null
  for (const share of shares) {
    const at = new Date(share.expiresAt).getTime()
    if (at <= now) continue
    if (soonest === null || at < soonest) soonest = at
  }
  return soonest
}
