import type { RoomParticipantDto } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import {
  VIEWER_CONSENT_LEVEL,
  becameModerator,
  canModerate,
  consentDecision,
  initiatorName,
  pendingConsentFor,
} from './consent'

const HUMAN = '11111111-1111-4111-8111-111111111111' as RoomParticipantDto['humanId'] & string
const OTHER = '22222222-2222-4222-8222-222222222222' as RoomParticipantDto['humanId'] & string

function participant(overrides: Partial<RoomParticipantDto> = {}): RoomParticipantDto {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    humanId: HUMAN,
    guestSessionId: null,
    displayName: 'Xavier',
    avatarUrl: null,
    isGuest: false,
    role: 'participant',
    mediaState: 'camera',
    status: 'active',
    audienceConsentLevel: 'group',
    joinedAt: '2026-09-03T10:00:00.000Z',
    relationToViewer: 'friend',
    ...overrides,
  }
}

describe('consentDecision (SCREEN 16; ARCHITECTURE §10)', () => {
  it('never asks a viewer for consent', () => {
    const decision = consentDecision({
      room: { visibility: 'world', pendingVisibility: null },
      myConsentLevel: null,
      mediaState: 'watching',
    })
    expect(decision).toEqual({ level: 'world', required: false, showSheet: false })
    expect(VIEWER_CONSENT_LEVEL).toBe('invited')
  })

  it('sends the consent level silently inside a group room or "Just us"', () => {
    expect(
      consentDecision({
        room: { visibility: 'group', pendingVisibility: null },
        myConsentLevel: null,
        mediaState: 'camera',
      }),
    ).toEqual({ level: 'group', required: true, showSheet: false })
    expect(
      consentDecision({
        room: { visibility: 'invited', pendingVisibility: null },
        myConsentLevel: null,
        mediaState: 'audio',
      }),
    ).toEqual({ level: 'invited', required: false, showSheet: false })
  })

  it('shows the sheet for a wider Live the person has not consented to', () => {
    expect(
      consentDecision({
        room: { visibility: 'friends', pendingVisibility: null },
        myConsentLevel: null,
        mediaState: 'camera',
      }),
    ).toEqual({ level: 'friends', required: true, showSheet: true })
    expect(
      consentDecision({
        room: { visibility: 'world', pendingVisibility: null },
        myConsentLevel: 'friends',
        mediaState: 'audio',
      }),
    ).toEqual({ level: 'world', required: true, showSheet: true })
  })

  it('asks for the pending (wider) visibility when an Open up is waiting', () => {
    expect(
      consentDecision({
        room: { visibility: 'group', pendingVisibility: 'world' },
        myConsentLevel: 'group',
        mediaState: 'camera',
      }),
    ).toEqual({ level: 'world', required: true, showSheet: true })
  })

  it('does not ask again once consent covers the room', () => {
    expect(
      consentDecision({
        room: { visibility: 'friends', pendingVisibility: null },
        myConsentLevel: 'world',
        mediaState: 'camera',
      }),
    ).toEqual({ level: 'friends', required: false, showSheet: false })
  })
})

describe('pendingConsentFor (Open up awaiting participants)', () => {
  it('prompts an active publisher whose consent is narrower than the pending visibility', () => {
    expect(
      pendingConsentFor({ visibility: 'group', pendingVisibility: 'friends' }, participant()),
    ).toBe('friends')
  })

  it('leaves viewers, guests, consenting and absent participants alone', () => {
    const room = { visibility: 'group', pendingVisibility: 'friends' } as const
    expect(pendingConsentFor(room, participant({ mediaState: 'watching' }))).toBeNull()
    expect(pendingConsentFor(room, participant({ isGuest: true }))).toBeNull()
    expect(pendingConsentFor(room, participant({ audienceConsentLevel: 'world' }))).toBeNull()
    expect(pendingConsentFor(room, participant({ status: 'left' }))).toBeNull()
    expect(pendingConsentFor(room, null)).toBeNull()
    expect(pendingConsentFor({ visibility: 'group', pendingVisibility: null }, participant())).toBeNull()
  })
})

describe('moderation helpers (spec §61, SCREEN 18)', () => {
  it('only active Human initiators/moderators moderate', () => {
    expect(canModerate(participant({ role: 'initiator' }))).toBe(true)
    expect(canModerate(participant({ role: 'moderator' }))).toBe(true)
    expect(canModerate(participant({ role: 'participant' }))).toBe(false)
    expect(canModerate(participant({ role: 'moderator', isGuest: true }))).toBe(false)
    expect(canModerate(participant({ role: 'moderator', status: 'left' }))).toBe(false)
    expect(canModerate(null)).toBe(false)
  })

  it('detects a transfer into moderation', () => {
    expect(becameModerator('participant', 'moderator')).toBe(true)
    expect(becameModerator('viewer', 'initiator')).toBe(true)
    expect(becameModerator('moderator', 'moderator')).toBe(false)
    expect(becameModerator('initiator', 'moderator')).toBe(false)
  })

  it('names the initiator, else the first person on camera', () => {
    const initiator = participant({ humanId: OTHER, displayName: 'Maya', mediaState: 'audio' })
    const room = { initiatedByHumanId: OTHER, participants: [participant(), initiator] }
    expect(initiatorName(room)).toBe('Maya')
    expect(initiatorName({ initiatedByHumanId: OTHER, participants: [participant()] })).toBe('Xavier')
    expect(initiatorName({ initiatedByHumanId: OTHER, participants: [] })).toBeNull()
  })
})
