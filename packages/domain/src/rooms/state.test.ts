import { describe, expect, it } from 'vitest'

import { ROOM_VISIBILITY } from '../enums'
import {
  canJoinWithMedia,
  describeVisibility,
  isRoomVisibleTo,
  nextConsentLevelFor,
  RECONNECT_POLICY,
  reconnectDelayMs,
  requiresConsent,
  type ViewerRelationToRoom,
} from './state'

const nobody: ViewerRelationToRoom = {
  isMember: false,
  isFriendOfParticipant: false,
  isInvited: false,
  hasLink: false,
}
const friend: ViewerRelationToRoom = { ...nobody, isFriendOfParticipant: true }
const member: ViewerRelationToRoom = { ...nobody, isMember: true }
const invited: ViewerRelationToRoom = { ...nobody, isInvited: true }
const linked: ViewerRelationToRoom = { ...nobody, hasLink: true }

describe('canJoinWithMedia (client mirror of room_join)', () => {
  it('guests need a link and guests enabled', () => {
    expect(
      canJoinWithMedia({
        visibility: 'invited',
        joinPolicy: 'invited_only',
        viewerRelationToRoom: linked,
        isGuest: true,
        guestsDisabled: true,
        mediaState: 'camera',
      }),
    ).toEqual({ allowed: false, reason: 'guests_disabled' })
    expect(
      canJoinWithMedia({
        visibility: 'world',
        joinPolicy: 'anyone',
        viewerRelationToRoom: nobody,
        isGuest: true,
        guestsDisabled: false,
        mediaState: 'watching',
      }),
    ).toEqual({ allowed: false, reason: 'guest_not_allowed' })
    expect(
      canJoinWithMedia({
        visibility: 'invited',
        joinPolicy: 'invited_only',
        viewerRelationToRoom: linked,
        isGuest: true,
        guestsDisabled: false,
        mediaState: 'camera',
      }),
    ).toEqual({ allowed: true })
  })

  it('watching only requires visibility (spec §59 "Default: viewer")', () => {
    expect(
      canJoinWithMedia({
        visibility: 'friends',
        joinPolicy: 'invited_only',
        viewerRelationToRoom: friend,
        isGuest: false,
        guestsDisabled: false,
        mediaState: 'watching',
      }),
    ).toEqual({ allowed: true })
    expect(
      canJoinWithMedia({
        visibility: 'friends',
        joinPolicy: 'friends',
        viewerRelationToRoom: nobody,
        isGuest: false,
        guestsDisabled: false,
        mediaState: 'watching',
      }),
    ).toEqual({ allowed: false, reason: 'not_visible' })
    expect(
      canJoinWithMedia({
        visibility: 'world',
        joinPolicy: 'invited_only',
        viewerRelationToRoom: nobody,
        isGuest: false,
        guestsDisabled: false,
        mediaState: 'watching',
      }),
    ).toEqual({ allowed: true })
  })

  it('publishing follows the join policy', () => {
    const base = {
      visibility: 'world' as const,
      isGuest: false,
      guestsDisabled: false,
      mediaState: 'camera' as const,
    }
    expect(
      canJoinWithMedia({ ...base, joinPolicy: 'invited_only', viewerRelationToRoom: nobody }),
    ).toEqual({ allowed: false, reason: 'join_not_allowed' })
    expect(
      canJoinWithMedia({ ...base, joinPolicy: 'invited_only', viewerRelationToRoom: invited }),
    ).toEqual({ allowed: true })
    expect(
      canJoinWithMedia({ ...base, joinPolicy: 'group', viewerRelationToRoom: member }),
    ).toEqual({ allowed: true })
    expect(
      canJoinWithMedia({ ...base, joinPolicy: 'group', viewerRelationToRoom: friend }),
    ).toEqual({ allowed: false, reason: 'join_not_allowed' })
    expect(
      canJoinWithMedia({ ...base, joinPolicy: 'friends', viewerRelationToRoom: friend }),
    ).toEqual({ allowed: true })
    expect(
      canJoinWithMedia({
        ...base,
        joinPolicy: 'friends_of_friends',
        viewerRelationToRoom: { ...nobody, isFriendOfFriendOfParticipant: true },
      }),
    ).toEqual({ allowed: true })
    expect(
      canJoinWithMedia({ ...base, joinPolicy: 'friends_of_friends', viewerRelationToRoom: nobody }),
    ).toEqual({ allowed: false, reason: 'join_not_allowed' })
    expect(
      canJoinWithMedia({ ...base, joinPolicy: 'request', viewerRelationToRoom: nobody }),
    ).toEqual({ allowed: true, requiresApproval: true })
    expect(
      canJoinWithMedia({ ...base, joinPolicy: 'request', viewerRelationToRoom: invited }),
    ).toEqual({ allowed: true })
    expect(
      canJoinWithMedia({ ...base, joinPolicy: 'anyone_with_link', viewerRelationToRoom: nobody }),
    ).toEqual({ allowed: false, reason: 'join_not_allowed' })
    expect(
      canJoinWithMedia({ ...base, joinPolicy: 'anyone_with_link', viewerRelationToRoom: linked }),
    ).toEqual({ allowed: true })
    expect(
      canJoinWithMedia({ ...base, joinPolicy: 'anyone', viewerRelationToRoom: nobody }),
    ).toEqual({ allowed: true })
  })

  it('room visibility mirrors earth.room_visible_to', () => {
    expect(isRoomVisibleTo('invited', nobody, false)).toBe(false)
    expect(isRoomVisibleTo('invited', invited, false)).toBe(true)
    expect(isRoomVisibleTo('group', member, false)).toBe(true)
    expect(isRoomVisibleTo('group', friend, false)).toBe(false)
    expect(isRoomVisibleTo('friends', friend, false)).toBe(true)
    expect(
      isRoomVisibleTo('extended', { ...nobody, isFriendOfFriendOfParticipant: true }, false),
    ).toBe(true)
    expect(isRoomVisibleTo('extended', nobody, false)).toBe(false)
    for (const v of ['neighborhood', 'city', 'world'] as const)
      expect(isRoomVisibleTo(v, nobody, false)).toBe(true)
    expect(isRoomVisibleTo('world', nobody, true)).toBe(false)
    expect(isRoomVisibleTo('invited', linked, true)).toBe(true)
  })
})

describe('consent helpers (ARCHITECTURE §10)', () => {
  it('viewers never need consent; publishers need consent ≥ visibility', () => {
    expect(
      requiresConsent({ roomVisibility: 'world', myConsentLevel: null, mediaState: 'watching' }),
    ).toBe(false)
    expect(
      requiresConsent({ roomVisibility: 'friends', myConsentLevel: null, mediaState: 'camera' }),
    ).toBe(true)
    expect(
      requiresConsent({ roomVisibility: 'friends', myConsentLevel: 'group', mediaState: 'audio' }),
    ).toBe(true)
    expect(
      requiresConsent({
        roomVisibility: 'friends',
        myConsentLevel: 'friends',
        mediaState: 'camera',
      }),
    ).toBe(false)
    expect(
      requiresConsent({ roomVisibility: 'friends', myConsentLevel: 'world', mediaState: 'camera' }),
    ).toBe(false)
  })

  it('asks for the wider of current and pending visibility', () => {
    expect(nextConsentLevelFor('friends')).toBe('friends')
    expect(nextConsentLevelFor('friends', null)).toBe('friends')
    expect(nextConsentLevelFor('friends', 'world')).toBe('world')
    expect(nextConsentLevelFor('city', 'friends')).toBe('city')
  })
})

describe('describeVisibility (SCREEN 15)', () => {
  it('describes every visibility with label, sentence and discoverability', () => {
    for (const visibility of ROOM_VISIBILITY) {
      const d = describeVisibility(visibility)
      expect(d.visibility).toBe(visibility)
      expect(d.label.length).toBeGreaterThan(0)
      expect(d.description.endsWith('.')).toBe(true)
      expect(d.discoverable).toBe(d.scope !== null)
    }
    expect(describeVisibility('invited')).toMatchObject({
      label: 'Just us',
      scope: null,
      discoverable: false,
    })
    expect(describeVisibility('group')).toMatchObject({ label: 'Group', scope: null })
    expect(describeVisibility('friends')).toMatchObject({
      label: 'Friends',
      scope: 'friends',
      discoverable: true,
    })
    expect(describeVisibility('extended')).toMatchObject({ scope: 'friends' })
    expect(describeVisibility('world')).toMatchObject({ label: 'World', scope: 'world' })
  })
})

describe('RECONNECT_POLICY (spec §109)', () => {
  it('five attempts with exponential backoff', () => {
    expect(RECONNECT_POLICY).toEqual({ attempts: 5, backoffMs: [500, 1000, 2000, 4000, 8000] })
    expect(reconnectDelayMs(1)).toBe(500)
    expect(reconnectDelayMs(5)).toBe(8000)
    expect(reconnectDelayMs(6)).toBeNull()
    expect(reconnectDelayMs(0)).toBeNull()
    expect(reconnectDelayMs(1.5)).toBeNull()
  })
})
