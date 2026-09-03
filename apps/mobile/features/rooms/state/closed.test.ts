import { copy } from '@earth/ui'
import { describe, expect, it } from 'vitest'

import { roomCopy } from '../copy'
import { closedKindForError, isLinkUnusable, roomClosedLine } from './closed'

describe('roomClosedLine', () => {
  it('names each closed state', () => {
    expect(roomClosedLine('ended', true)).toBe(roomCopy.roomEnded)
    expect(roomClosedLine('removed', true)).toBe(roomCopy.removedFromRoom)
    expect(roomClosedLine('not_visible', true)).toBe(roomCopy.roomNotVisible)
    expect(roomClosedLine('error', true)).toBe(roomCopy.couldntOpenRoom)
  })

  it('says the connection is unavailable when a read failed offline (spec §107)', () => {
    expect(roomClosedLine('error', false)).toBe(copy.connectionUnavailable)
    expect(roomClosedLine('error', false)).toBe('Connection unavailable')
    // Being offline does not change what ended or removed means.
    expect(roomClosedLine('ended', false)).toBe(roomCopy.roomEnded)
  })
})

describe('closedKindForError', () => {
  it('maps room errors onto the quiet end states', () => {
    expect(closedKindForError('room_ended')).toBe('ended')
    expect(closedKindForError('not_visible')).toBe('not_visible')
    expect(closedKindForError('forbidden')).toBe('not_visible')
    expect(closedKindForError('internal')).toBe('error')
    expect(closedKindForError('rate_limited')).toBe('error')
  })
})

describe('isLinkUnusable', () => {
  it('recognises dead links', () => {
    expect(isLinkUnusable('invite_expired')).toBe(true)
    expect(isLinkUnusable('invite_invalid')).toBe(true)
    expect(isLinkUnusable('room_ended')).toBe(true)
    expect(isLinkUnusable('guests_disabled')).toBe(false)
  })
})
