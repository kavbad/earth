import { fixtures } from '@earth/api/testing'
import { LocationShareDtoSchema } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { locationCopy } from '../copy'
import type { MyShare } from './myShares'
import { audienceNameFor, mergeWithServer, myShareFromDto } from './shareSync'

const NOW = Date.parse('2026-01-01T10:00:00Z')
const LATER = new Date(NOW + 3_600_000).toISOString()
const EARLIER = new Date(NOW - 60_000).toISOString()

function dto(overrides: Partial<ReturnType<typeof fixtures.locationShare>> = {}) {
  return LocationShareDtoSchema.parse({
    ...fixtures.locationShare(),
    expiresAt: LATER,
    createdAt: EARLIER,
    revokedAt: null,
    ...overrides,
  })
}

describe('own shares reconciled with the server', () => {
  it('keeps the device name for a share the server still lists', () => {
    const server = dto()
    const device: MyShare = myShareFromDto(server, 'Weekend Crew')
    const merged = mergeWithServer([device], [server], [], NOW)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.audienceName).toBe('Weekend Crew')
  })

  it('drops a share the server no longer lists (revoked elsewhere) and revoked rows', () => {
    const server = dto()
    const revoked = dto({ id: '11111111-1111-4111-8111-111111111111', revokedAt: EARLIER })
    const gone: MyShare = myShareFromDto(
      dto({ id: '22222222-2222-4222-8222-222222222222' }),
      'Family',
    )
    const merged = mergeWithServer(
      [gone, myShareFromDto(server, 'Weekend Crew')],
      [server, revoked],
      [],
      NOW,
    )
    expect(merged.map((share) => share.id)).toEqual([server.id])
  })

  it('names a share started elsewhere from the known audiences, else generically', () => {
    const server = dto()
    const named = mergeWithServer(
      [],
      [server],
      [{ type: server.audienceType, id: server.audienceId, name: 'College' }],
      NOW,
    )
    expect(named[0]?.audienceName).toBe('College')
    const generic = mergeWithServer([], [server], [], NOW)
    expect(generic[0]?.audienceName).toBe(locationCopy.unknownAudience[server.audienceType])
    expect(audienceNameFor(server, [])).toBe(locationCopy.unknownAudience[server.audienceType])
  })

  it('drops expired shares whatever the server says', () => {
    const expired = dto({ expiresAt: EARLIER })
    expect(mergeWithServer([], [expired], [], NOW)).toEqual([])
  })

  it('never carries a position: a share is only ids, precision and times', () => {
    const share = myShareFromDto(dto(), 'Weekend Crew')
    expect(Object.keys(share).sort()).toEqual(
      [
        'audienceId',
        'audienceName',
        'audienceType',
        'createdAt',
        'expiresAt',
        'id',
        'precision',
      ].sort(),
    )
  })
})
