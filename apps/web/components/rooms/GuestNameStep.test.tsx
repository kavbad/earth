import { copy } from '@earth/ui'
import { describe, expect, it } from 'vitest'

import { guestJoinErrorLine } from './GuestNameStep'
import { roomCopy } from './copy'

describe('guestJoinErrorLine (SCREEN 17; spec §107)', () => {
  it('says nothing until something failed', () => {
    expect(guestJoinErrorLine(null, true)).toBeNull()
    expect(guestJoinErrorLine(null, false)).toBeNull()
  })

  it('asks for a name whatever the connection is doing', () => {
    expect(guestJoinErrorLine('name_missing', true)).toBe(roomCopy.guestNameMissing)
    expect(guestJoinErrorLine('name_missing', false)).toBe(roomCopy.guestNameMissing)
  })

  it('blames the connection, not the room, when the device cannot reach Earth', () => {
    expect(guestJoinErrorLine('join_failed', true)).toBe(roomCopy.guestJoinFailed)
    expect(guestJoinErrorLine('join_failed', false)).toBe(copy.connectionUnavailable)
  })
})
