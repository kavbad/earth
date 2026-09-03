import { describe, expect, it } from 'vitest'

import { compareLiveRooms, liveRankFeatures, liveTierFor, orderLiveRooms } from './live-order'
import { hoursBefore, liveRoom, participant } from '../test/fixtures'

describe('liveRankFeatures', () => {
  it('counts only active publishers other than the viewer, guests never as friends', () => {
    const room = liveRoom(1, {
      participants: [
        participant(1, { relationToViewer: 'friend' }),
        participant(2, { relationToViewer: 'friend', mediaState: 'watching' }),
        participant(3, { relationToViewer: 'friend', status: 'left' }),
        participant(4, { relationToViewer: 'self' }),
        participant(5, { relationToViewer: 'friend', isGuest: true }),
        participant(6, { relationToViewer: 'shared_group' }),
        participant(7, { relationToViewer: 'familiar', mediaState: 'audio' }),
      ],
    })
    const features = liveRankFeatures(room)
    expect(features.friendCount).toBe(1)
    expect(features.adjacentCount).toBe(2)
    expect(features.publisherCount).toBe(4)
    expect(features.isGroupRoom).toBe(false)
  })

  it('prefers the RPC participant count when provided', () => {
    expect(liveRankFeatures(liveRoom(1, { participantCount: 9 })).publisherCount).toBe(9)
  })
})

describe('orderLiveRooms (friends scope, SCREEN 13)', () => {
  const twoFriends = liveRoom(1, {
    participants: [
      participant(1, { relationToViewer: 'friend' }),
      participant(2, { relationToViewer: 'friend' }),
    ],
  })
  const oneFriendBig = liveRoom(2, {
    participants: [
      participant(3, { relationToViewer: 'friend' }),
      participant(4, { relationToViewer: 'other' }),
      participant(5, { relationToViewer: 'other' }),
    ],
  })
  const groupRoom = liveRoom(3, {
    contextType: 'group',
    contextTitle: 'Weekend Crew',
    participants: [
      participant(6, { relationToViewer: 'shared_group' }),
      participant(7, { relationToViewer: 'shared_group' }),
    ],
  })
  const friendsOfFriends = liveRoom(4, {
    participants: [
      participant(8, { relationToViewer: 'familiar' }),
      participant(9),
      participant(10),
    ],
  })
  const strangersBig = liveRoom(5, {
    participants: [participant(11), participant(12), participant(13), participant(14)],
  })
  const strangersNew = liveRoom(6, {
    startedAt: hoursBefore(0.01),
    participants: [participant(15)],
  })
  const strangersOld = liveRoom(7, { startedAt: hoursBefore(3), participants: [participant(16)] })

  it('ranks closest friends, then group rooms, then socially adjacent, then others', () => {
    const shuffled = [
      strangersOld,
      friendsOfFriends,
      strangersNew,
      groupRoom,
      oneFriendBig,
      strangersBig,
      twoFriends,
    ]
    const ordered = orderLiveRooms(shuffled, 'friends').map((r) => r.roomId)
    expect(ordered).toEqual([
      twoFriends.roomId, // 2 friends beats 1 friend even with fewer people
      oneFriendBig.roomId,
      groupRoom.roomId,
      friendsOfFriends.roomId,
      strangersBig.roomId, // others: participant count first
      strangersNew.roomId, // then recency
      strangersOld.roomId,
    ])
  })

  it('tiers', () => {
    expect(liveTierFor(liveRankFeatures(twoFriends))).toBe('friends')
    expect(liveTierFor(liveRankFeatures(groupRoom))).toBe('group')
    expect(liveTierFor(liveRankFeatures(friendsOfFriends))).toBe('adjacent')
    expect(liveTierFor(liveRankFeatures(strangersBig))).toBe('other')
    // A group room containing a friend is still a friends-tier room.
    expect(
      liveTierFor(
        liveRankFeatures(
          liveRoom(9, {
            contextType: 'group',
            participants: [participant(1, { relationToViewer: 'friend' })],
          }),
        ),
      ),
    ).toBe('friends')
  })

  it('is deterministic: ties broken by room id', () => {
    const a = liveRoom(1, { participants: [participant(1)] })
    const b = liveRoom(2, { participants: [participant(2)] })
    expect(compareLiveRooms('world', a, b)).toBeLessThan(0)
    expect(compareLiveRooms('world', b, a)).toBeGreaterThan(0)
    expect(compareLiveRooms('world', a, a)).toBe(0)
  })

  it('drops duplicate room ids', () => {
    expect(orderLiveRooms([twoFriends, twoFriends, groupRoom], 'friends')).toHaveLength(2)
  })
})

describe('orderLiveRooms (other scopes)', () => {
  it('orders by participant count then recency regardless of relationships', () => {
    const friendSmall = liveRoom(1, {
      participants: [participant(1, { relationToViewer: 'friend' })],
    })
    const strangersBig = liveRoom(2, { participants: [participant(2), participant(3)] })
    const strangersNew = liveRoom(3, {
      startedAt: hoursBefore(0.01),
      participants: [participant(4)],
    })
    for (const scope of ['neighborhood', 'city', 'world'] as const) {
      expect(
        orderLiveRooms([friendSmall, strangersBig, strangersNew], scope).map((r) => r.roomId),
      ).toEqual([strangersBig.roomId, strangersNew.roomId, friendSmall.roomId])
    }
  })
})
