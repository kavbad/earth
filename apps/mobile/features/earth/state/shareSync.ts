/**
 * Own shares as the device remembers them versus what the server lists (`location_shares_mine`),
 * pure: the server decides which shares still exist (revoked from another device, swept), the
 * device keeps the audience names it learned when the share was made, and a share started
 * elsewhere gets a generic name until this device learns better.
 */
import type { LocationShareDto } from '@earth/domain'

import { locationCopy } from '../copy'
import { type MyShare, selectActiveShares } from './myShares'

/** A `LocationShareDto` as this device keeps it (no position — shares never carry one here). */
export function myShareFromDto(share: LocationShareDto, audienceName: string): MyShare {
  return {
    id: share.id,
    audienceType: share.audienceType,
    audienceId: share.audienceId,
    audienceName,
    precision: share.precision,
    expiresAt: share.expiresAt,
    createdAt: share.createdAt,
  }
}

export interface AudienceNameSource {
  readonly type: MyShare['audienceType']
  readonly id: string
  readonly name: string
}

export function audienceNameFor(
  share: Pick<LocationShareDto, 'audienceType' | 'audienceId'>,
  known: readonly AudienceNameSource[],
): string {
  const match = known.find(
    (candidate) => candidate.type === share.audienceType && candidate.id === share.audienceId,
  )
  return match?.name ?? locationCopy.unknownAudience[share.audienceType]
}

/**
 * The device list reconciled with the server's: only shares the server still lists survive
 * (revoked elsewhere disappear), server shares unknown here are added with the best name we
 * have, and everything expired or revoked is dropped. Newest first.
 */
export function mergeWithServer(
  device: readonly MyShare[],
  server: readonly LocationShareDto[],
  known: readonly AudienceNameSource[],
  now: number,
): MyShare[] {
  const live = server.filter((share) => share.revokedAt === null)
  const byId = new Map(device.map((share) => [share.id, share] as const))
  const merged: MyShare[] = live.map((share) => {
    const remembered = byId.get(share.id)
    return remembered !== undefined
      ? { ...remembered, expiresAt: share.expiresAt, precision: share.precision }
      : myShareFromDto(share, audienceNameFor(share, known))
  })
  return selectActiveShares(merged, now)
}
