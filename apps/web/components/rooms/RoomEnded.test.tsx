import { copy } from '@earth/ui'
import { describe, expect, it } from 'vitest'

import { ROOM_CLOSED_KINDS, closedKindForError, roomClosedLine } from './RoomEnded'
import { roomCopy } from './copy'

describe('roomClosedLine (spec §107, §109)', () => {
  it('says connection unavailable when Live could not be reached at all', () => {
    expect(roomClosedLine('error', true)).toBe(roomCopy.couldntOpenRoom)
    expect(roomClosedLine('error', false)).toBe(copy.connectionUnavailable)
  })

  it('keeps a settled answer whatever the network is doing', () => {
    for (const kind of ROOM_CLOSED_KINDS) {
      if (kind === 'error') continue
      expect(roomClosedLine(kind, false)).toBe(roomClosedLine(kind, true))
    }
    expect(roomClosedLine('ended', true)).toBe(roomCopy.roomEnded)
    expect(roomClosedLine('removed', true)).toBe(roomCopy.removedFromRoom)
    expect(roomClosedLine('not_visible', true)).toBe(roomCopy.roomNotVisible)
  })

  it('maps error codes to the kind the screen shows', () => {
    expect(closedKindForError('room_ended')).toBe('ended')
    expect(closedKindForError('not_visible')).toBe('not_visible')
    expect(closedKindForError('forbidden')).toBe('not_visible')
    // A dropped connection arrives as `internal`: retryable, not a verdict on the room.
    expect(closedKindForError('internal')).toBe('error')
  })
})
