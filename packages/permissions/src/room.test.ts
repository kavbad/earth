import { ROOM_JOIN_POLICY, ROOM_VISIBILITY } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { canJoinRoom, canViewRoom } from './room'
import { DEFAULT_PERMISSION_FLAGS, type RoomJoinInput, type Viewer } from './types'

const room = (extra: Partial<RoomJoinInput> = {}): RoomJoinInput => ({
  visibility: 'friends',
  joinPolicy: 'friends',
  status: 'active',
  guestsDisabled: false,
  ...extra,
})
const human = (extra: Partial<Viewer> = {}): Viewer => ({
  kind: 'human',
  relationToAuthor: 'other',
  blockedEitherWay: false,
  ...extra,
})
const camera = { mediaState: 'camera', consentLevel: 'world' } as const
const watch = { mediaState: 'watching', consentLevel: 'invited' } as const

describe('canViewRoom (mirror of earth.room_visible_to)', () => {
  it('a live seat always sees its room, blocks hide it otherwise, members see group rooms', () => {
    expect(
      canViewRoom(
        human({ isInvitedParticipant: true, blockedEitherWay: true }),
        room({ visibility: 'invited' }),
      ),
    ).toBe(true)
    expect(
      canViewRoom(human({ isFriendOfConsentingParticipant: true, blockedEitherWay: true }), room()),
    ).toBe(false)
    expect(
      canViewRoom(
        human({ isGroupMember: true, blockedEitherWay: true }),
        room({ visibility: 'group' }),
      ),
    ).toBe(false)
    expect(
      canViewRoom(human({ isGroupMember: true }), room({ visibility: 'group', status: 'ended' })),
    ).toBe(true)
  })

  it('only live rooms are discoverable beyond their context', () => {
    expect(canViewRoom(human(), room({ visibility: 'world', status: 'ended' }))).toBe(false)
    expect(canViewRoom(human(), room({ visibility: 'world', status: 'ending' }))).toBe(false)
    expect(canViewRoom(human(), room({ visibility: 'world', status: 'starting' }))).toBe(true)
    expect(canViewRoom(human(), room({ visibility: 'world' }))).toBe(true)
  })

  it('walks the visibility ladder invited < group < friends < extended < neighborhood < city < world', () => {
    const friend = human({ isFriendOfConsentingParticipant: true })
    const friendOfFriend = human({ isFriendOfFriendOfConsentingParticipant: true })
    const neighbor = human({ sameNeighborhood: true, sameCity: true })
    const citizen = human({ sameCity: true })
    const stranger = human()
    const expectations: Record<(typeof ROOM_VISIBILITY)[number], boolean[]> = {
      invited: [false, false, false, false, false],
      group: [false, false, false, false, false],
      friends: [true, false, false, false, false],
      extended: [true, true, false, false, false],
      neighborhood: [true, true, true, false, false],
      city: [true, true, true, true, false],
      world: [true, true, true, true, true],
    }
    for (const visibility of ROOM_VISIBILITY) {
      const actual = [friend, friendOfFriend, neighbor, citizen, stranger].map((viewer) =>
        canViewRoom(viewer, room({ visibility })),
      )
      expect(actual, visibility).toEqual(expectations[visibility])
    }
  })

  it('a link alone does not make a room visible to a Human until they join', () => {
    expect(canViewRoom(human({ hasLink: true }), room({ visibility: 'invited' }))).toBe(false)
  })

  it('visitors and claiming Humans see World Lives while PUBLIC_LIVE_ENABLED', () => {
    for (const kind of ['visitor', 'claiming'] as const) {
      const viewer: Viewer = { kind, blockedEitherWay: false }
      expect(canViewRoom(viewer, room({ visibility: 'world' }))).toBe(true)
      expect(
        canViewRoom(viewer, room({ visibility: 'world' }), {
          ...DEFAULT_PERMISSION_FLAGS,
          publicLiveEnabled: false,
        }),
      ).toBe(false)
      expect(canViewRoom(viewer, room({ visibility: 'city' }))).toBe(false)
      expect(canViewRoom(viewer, room({ visibility: 'world', status: 'ended' }))).toBe(false)
    }
  })

  it('guests exist only inside the room their link or session belongs to', () => {
    expect(
      canViewRoom({ kind: 'guest', blockedEitherWay: false }, room({ visibility: 'world' })),
    ).toBe(false)
    expect(
      canViewRoom(
        { kind: 'guest', blockedEitherWay: false, hasLink: true },
        room({ visibility: 'invited' }),
      ),
    ).toBe(true)
    expect(
      canViewRoom(
        { kind: 'guest', blockedEitherWay: false, hasLink: true },
        room({ guestsDisabled: true }),
      ),
    ).toBe(false)
    expect(
      canViewRoom(
        { kind: 'guest', blockedEitherWay: false, hasLink: true },
        room({ status: 'ended' }),
      ),
    ).toBe(false)
    expect(canViewRoom({ kind: 'guest', blockedEitherWay: true, hasLink: true }, room())).toBe(
      false,
    )
    expect(
      canViewRoom({ kind: 'guest', blockedEitherWay: false, hasLink: true }, room(), {
        ...DEFAULT_PERMISSION_FLAGS,
        guestRoomsEnabled: false,
      }),
    ).toBe(false)
    expect(
      canViewRoom(
        { kind: 'guest', blockedEitherWay: false, isInvitedParticipant: true },
        room({ status: 'ended' }),
      ),
    ).toBe(true)
    expect(
      canViewRoom(
        { kind: 'guest', blockedEitherWay: false, isInvitedParticipant: true },
        room({ guestsDisabled: true }),
      ),
    ).toBe(false)
  })
})

describe('canJoinRoom reasons (mirror of room_join / room_invite_join / guest_session_create)', () => {
  it('rejects callers that are not active Humans with the assert_human codes', () => {
    expect(
      canJoinRoom(
        { kind: 'visitor', blockedEitherWay: false },
        room({ visibility: 'world' }),
        watch,
      ),
    ).toEqual({ allowed: false, reason: 'not_authenticated' })
    expect(
      canJoinRoom(
        { kind: 'claiming', blockedEitherWay: false },
        room({ visibility: 'world' }),
        watch,
      ),
    ).toEqual({ allowed: false, reason: 'not_a_human' })
    expect(
      canJoinRoom(
        { kind: 'service', blockedEitherWay: false },
        room({ visibility: 'world' }),
        watch,
      ),
    ).toEqual({ allowed: false, reason: 'not_a_human' })
  })

  it('a room the Human cannot see does not exist for them, unless a link reaches it', () => {
    expect(
      canJoinRoom(human(), room({ visibility: 'invited', joinPolicy: 'anyone' }), camera),
    ).toEqual({ allowed: false, reason: 'room_not_found' })
    expect(
      canJoinRoom(
        human({ hasLink: true }),
        room({ visibility: 'invited', joinPolicy: 'invited_only' }),
        camera,
      ),
    ).toEqual({ allowed: true })
    expect(
      canJoinRoom(
        human({ hasLink: true, blockedEitherWay: true }),
        room({ visibility: 'invited', joinPolicy: 'anyone' }),
        camera,
      ),
    ).toEqual({ allowed: false, reason: 'room_not_found' })
  })

  it('ended rooms cannot be joined even by their participants', () => {
    expect(
      canJoinRoom(human({ isInvitedParticipant: true }), room({ status: 'ended' }), watch),
    ).toEqual({ allowed: false, reason: 'room_ended' })
    expect(
      canJoinRoom(
        { kind: 'guest', blockedEitherWay: false, hasLink: true },
        room({ status: 'ended' }),
        camera,
      ),
    ).toEqual({ allowed: false, reason: 'room_ended' })
  })

  it('watching needs only visibility (spec §59 "Default: viewer")', () => {
    expect(
      canJoinRoom(human(), room({ visibility: 'world', joinPolicy: 'invited_only' }), watch),
    ).toEqual({ allowed: true })
    expect(
      canJoinRoom(
        human({ isFriendOfConsentingParticipant: true }),
        room({ joinPolicy: 'invited_only' }),
        watch,
      ),
    ).toEqual({ allowed: true })
  })

  it('join policy: who may publish', () => {
    const stranger = human()
    const invited = human({ isInvitedParticipant: true })
    const linked = human({ hasLink: true })
    const member = human({ isGroupMember: true })
    const friend = human({ isFriendOfConsentingParticipant: true })
    const friendOfFriend = human({ isFriendOfFriendOfConsentingParticipant: true })
    const world = (joinPolicy: RoomJoinInput['joinPolicy']) =>
      room({ visibility: 'world', joinPolicy })
    const table: Record<(typeof ROOM_JOIN_POLICY)[number], boolean[]> = {
      //              stranger invited linked member friend fof
      invited_only: [false, true, true, false, false, false],
      group: [false, true, true, true, false, false],
      friends: [false, true, true, true, true, false],
      friends_of_friends: [false, true, true, true, true, true],
      request: [true, true, true, true, true, true],
      anyone_with_link: [false, true, true, false, false, false],
      anyone: [true, true, true, true, true, true],
    }
    for (const joinPolicy of ROOM_JOIN_POLICY) {
      const actual = [stranger, invited, linked, member, friend, friendOfFriend].map(
        (viewer) => canJoinRoom(viewer, world(joinPolicy), camera).allowed,
      )
      expect(actual, joinPolicy).toEqual(table[joinPolicy])
    }
    expect(canJoinRoom(stranger, world('invited_only'), camera)).toEqual({
      allowed: false,
      reason: 'join_not_allowed',
    })
    expect(canJoinRoom(stranger, world('request'), camera)).toEqual({
      allowed: true,
      requiresApproval: true,
    })
    expect(canJoinRoom(member, world('request'), camera)).toEqual({ allowed: true })
    expect(canJoinRoom(invited, world('request'), camera)).toEqual({ allowed: true })
  })

  it('consent must cover the room visibility for audio/camera, after the policy check', () => {
    const friend = human({ isFriendOfConsentingParticipant: true })
    expect(
      canJoinRoom(friend, room({ visibility: 'city', joinPolicy: 'friends' }), {
        mediaState: 'camera',
        consentLevel: 'friends',
      }),
    ).toEqual({ allowed: false, reason: 'consent_required' })
    expect(
      canJoinRoom(friend, room({ visibility: 'city', joinPolicy: 'friends' }), {
        mediaState: 'audio',
        consentLevel: 'city',
      }),
    ).toEqual({ allowed: true })
    expect(
      canJoinRoom(friend, room({ visibility: 'city', joinPolicy: 'friends' }), {
        mediaState: 'audio',
        consentLevel: 'world',
      }),
    ).toEqual({ allowed: true })
    expect(
      canJoinRoom(friend, room({ visibility: 'city', joinPolicy: 'friends' }), {
        mediaState: 'watching',
        consentLevel: 'invited',
      }),
    ).toEqual({ allowed: true })
    // Policy failure wins over missing consent.
    const citizen = human({ sameCity: true })
    expect(
      canJoinRoom(citizen, room({ visibility: 'city', joinPolicy: 'friends' }), {
        mediaState: 'camera',
        consentLevel: 'invited',
      }),
    ).toEqual({ allowed: false, reason: 'join_not_allowed' })
    // A request seat still needs consent.
    expect(
      canJoinRoom(citizen, room({ visibility: 'city', joinPolicy: 'request' }), {
        mediaState: 'camera',
        consentLevel: 'invited',
      }),
    ).toEqual({ allowed: false, reason: 'consent_required' })
    expect(
      canJoinRoom(citizen, room({ visibility: 'city', joinPolicy: 'request' }), {
        mediaState: 'camera',
        consentLevel: 'city',
      }),
    ).toEqual({ allowed: true, requiresApproval: true })
    // Invisible rooms do not exist for the viewer, whatever the policy.
    expect(
      canJoinRoom(human(), room({ visibility: 'city', joinPolicy: 'anyone' }), {
        mediaState: 'camera',
        consentLevel: 'city',
      }),
    ).toEqual({ allowed: false, reason: 'room_not_found' })
  })

  it('guests: link or session, flag, room state, guests allowed, room-level block', () => {
    const linked: Viewer = { kind: 'guest', blockedEitherWay: false, hasLink: true }
    const seated: Viewer = { kind: 'guest', blockedEitherWay: false, isInvitedParticipant: true }
    expect(canJoinRoom({ kind: 'guest', blockedEitherWay: false }, room(), camera)).toEqual({
      allowed: false,
      reason: 'guest_not_allowed',
    })
    expect(
      canJoinRoom(linked, room(), camera, {
        ...DEFAULT_PERMISSION_FLAGS,
        guestRoomsEnabled: false,
      }),
    ).toEqual({ allowed: false, reason: 'feature_disabled' })
    expect(canJoinRoom(linked, room({ guestsDisabled: true }), camera)).toEqual({
      allowed: false,
      reason: 'guests_disabled',
    })
    expect(canJoinRoom({ ...linked, blockedEitherWay: true }, room(), camera)).toEqual({
      allowed: false,
      reason: 'blocked',
    })
    expect(
      canJoinRoom(linked, room({ visibility: 'invited', joinPolicy: 'invited_only' }), {
        mediaState: 'camera',
        consentLevel: 'invited',
      }),
    ).toEqual({ allowed: true })
    // Guests never evaluate the policy or consent: the link is the invitation.
    expect(
      canJoinRoom(linked, room({ visibility: 'world', joinPolicy: 'friends' }), {
        mediaState: 'camera',
        consentLevel: 'invited',
      }),
    ).toEqual({ allowed: true })
    expect(canJoinRoom(seated, room(), camera)).toEqual({ allowed: true })
    expect(canJoinRoom(seated, room({ guestsDisabled: true }), camera)).toEqual({
      allowed: false,
      reason: 'guests_disabled',
    })
    expect(canJoinRoom(seated, room({ status: 'ended' }), camera)).toEqual({
      allowed: false,
      reason: 'room_ended',
    })
    expect(
      canJoinRoom(seated, room(), camera, {
        ...DEFAULT_PERMISSION_FLAGS,
        guestRoomsEnabled: false,
      }),
    ).toEqual({ allowed: true })
  })
})
