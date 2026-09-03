import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PERMISSION_FLAGS,
  PACKAGE_NAME,
  PERMISSION_FLAG_KEYS,
  ViewerSchema,
  assertHumanFailure,
  canViewObject,
  permissionFlagsFrom,
  type Viewer,
} from './index'

const friend: Viewer = { kind: 'human', relationToAuthor: 'friend', blockedEitherWay: false }
const visitor: Viewer = { kind: 'visitor', blockedEitherWay: false }

describe('@earth/permissions', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@earth/permissions')
  })

  it('canViewObject dispatches on object.type', () => {
    expect(
      canViewObject({
        viewer: friend,
        object: { type: 'post', audience: 'friends', status: 'active', isReply: false },
      }),
    ).toBe(true)
    expect(
      canViewObject({
        viewer: visitor,
        object: { type: 'post', audience: 'friends', status: 'active', isReply: false },
      }),
    ).toBe(false)
    expect(
      canViewObject({
        viewer: { ...friend, isFriendOfConsentingParticipant: true },
        object: { type: 'room', visibility: 'friends', status: 'active', guestsDisabled: false },
      }),
    ).toBe(true)
    expect(
      canViewObject({
        viewer: visitor,
        object: { type: 'room', visibility: 'world', status: 'active', guestsDisabled: false },
      }),
    ).toBe(true)
    expect(
      canViewObject({
        viewer: visitor,
        object: { type: 'room', visibility: 'world', status: 'active', guestsDisabled: false },
        flags: { ...DEFAULT_PERMISSION_FLAGS, publicLiveEnabled: false },
      }),
    ).toBe(false)
    expect(
      canViewObject({
        viewer: friend,
        object: { type: 'profile', profileVisibility: 'hidden', humanStatus: 'active' },
      }),
    ).toBe(true)
    expect(
      canViewObject({
        viewer: { ...friend, isConversationMember: true },
        object: { type: 'conversation', conversationType: 'direct' },
      }),
    ).toBe(true)
    expect(
      canViewObject({
        viewer: visitor,
        object: { type: 'conversation', conversationType: 'group' },
      }),
    ).toBe(false)
    expect(
      canViewObject({
        viewer: visitor,
        object: {
          type: 'group_invite_preview',
          profileVisibility: 'public',
          isFriendOfViewer: false,
        },
      }),
    ).toBe(true)
    expect(
      canViewObject({
        viewer: visitor,
        object: {
          type: 'group_invite_preview',
          profileVisibility: 'limited',
          isFriendOfViewer: false,
        },
      }),
    ).toBe(false)
  })

  it('projects feature flags onto the permission flags (missing = disabled)', () => {
    const at = '2026-09-03T00:00:00+00:00'
    expect(
      permissionFlagsFrom({
        PUBLIC_WORLD_ENABLED: { enabled: true, payload: null, updatedAt: at },
        PUBLIC_LIVE_ENABLED: { enabled: false, payload: null, updatedAt: at },
      }),
    ).toEqual({ publicWorldEnabled: true, publicLiveEnabled: false, guestRoomsEnabled: false })
    expect(Object.values(PERMISSION_FLAG_KEYS)).toEqual([
      'PUBLIC_WORLD_ENABLED',
      'PUBLIC_LIVE_ENABLED',
      'GUEST_ROOMS_ENABLED',
    ])
    expect(DEFAULT_PERMISSION_FLAGS).toEqual({
      publicWorldEnabled: true,
      publicLiveEnabled: true,
      guestRoomsEnabled: true,
    })
  })

  it('ViewerSchema requires kind and blockedEitherWay only', () => {
    expect(ViewerSchema.safeParse({ kind: 'human' }).success).toBe(false)
    expect(ViewerSchema.safeParse({ kind: 'human', blockedEitherWay: false }).success).toBe(true)
    expect(ViewerSchema.safeParse({ kind: 'robot', blockedEitherWay: false }).success).toBe(false)
  })

  it('assertHumanFailure mirrors earth.assert_human', () => {
    expect(assertHumanFailure('visitor')).toBe('not_authenticated')
    expect(assertHumanFailure('guest')).toBe('not_a_human')
    expect(assertHumanFailure('claiming')).toBe('not_a_human')
    expect(assertHumanFailure('service')).toBe('not_a_human')
    expect(assertHumanFailure('human')).toBeNull()
  })
})
