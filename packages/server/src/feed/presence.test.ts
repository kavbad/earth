/**
 * SCREEN 02 presence row assembly from `feed_presence()` rows: naming per spec §60, the three
 * canonical labels, and "render only when there is meaningful state".
 */
import { PRESENCE_ITEMS_MAX } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import {
  FeedPresenceResultSchema,
  friendsLiveItem,
  presenceCardFrom,
  type FeedPresenceResult,
} from './presence'
import { liveRoom, participant, presenceGroup, presenceNearbyFriend } from '../test/fixtures'

function parse(value: unknown): FeedPresenceResult {
  return FeedPresenceResultSchema.parse(value)
}

describe('FeedPresenceResultSchema', () => {
  it('accepts a missing result and missing sources as nothing to show', () => {
    expect(parse(null)).toEqual({ liveRooms: [], activeGroups: [], nearbyFriends: [] })
    expect(parse({})).toEqual({ liveRooms: [], activeGroups: [], nearbyFriends: [] })
    expect(presenceCardFrom(parse(null))).toBeNull()
  })
})

describe('friendsLiveItem', () => {
  it('names a friend Live and points the chip at the room (spec §60 order, viewer excluded)', () => {
    const room = liveRoom(1, {
      participants: [
        participant(2, { displayName: 'Nobody', relationToViewer: 'other' }),
        participant(3, { displayName: 'Maya', relationToViewer: 'friend' }),
        participant(4, { displayName: 'Xavier', relationToViewer: 'friend', mediaState: 'camera' }),
        participant(5, { displayName: 'Me', relationToViewer: 'self' }),
        participant(6, {
          displayName: 'Watcher',
          relationToViewer: 'friend',
          mediaState: 'watching',
        }),
      ],
    })
    const item = friendsLiveItem(room)
    expect(item).not.toBeNull()
    expect(item?.type).toBe('friends_live')
    expect(item?.label).toBe('Maya, Xavier + 1 live')
    expect(item?.roomId).toBe(room.roomId)
    expect(item?.conversationId).toBeNull()
    expect(item?.humanIds).toHaveLength(3)
  })

  it('drops a room with no friend publishing in it', () => {
    expect(
      friendsLiveItem(
        liveRoom(7, {
          participants: [participant(8, { displayName: 'Stranger', relationToViewer: 'other' })],
        }),
      ),
    ).toBeNull()
    expect(
      friendsLiveItem(
        liveRoom(9, {
          participants: [
            participant(10, {
              displayName: 'Xavier',
              relationToViewer: 'friend',
              mediaState: 'watching',
            }),
          ],
        }),
      ),
    ).toBeNull()
  })

  it('keeps only real avatar urls', () => {
    const item = friendsLiveItem(
      liveRoom(11, {
        participants: [
          participant(12, {
            displayName: 'Maya',
            relationToViewer: 'friend',
            avatarUrl: 'https://cdn.test/avatars/maya.jpg',
          }),
          participant(13, { displayName: 'Xavier', relationToViewer: 'friend', avatarUrl: null }),
        ],
      }),
    )
    expect(item?.avatarUrls).toEqual(['https://cdn.test/avatars/maya.jpg'])
  })
})

describe('presenceCardFrom', () => {
  it('builds the spec’s three items, in the row’s order', () => {
    const card = presenceCardFrom(
      parse({
        liveRooms: [
          liveRoom(1, {
            participants: [
              participant(2, { displayName: 'Xavier', relationToViewer: 'friend' }),
              participant(3, { displayName: 'Maya', relationToViewer: 'friend' }),
            ],
            participantCount: 2,
          }),
        ],
        activeGroups: [presenceGroup(4)],
        nearbyFriends: [presenceNearbyFriend(5)],
      }),
    )
    expect(card?.items.map((item) => [item.type, item.label])).toEqual([
      ['friends_live', 'Xavier + Maya live'],
      ['group_active', 'Weekend Crew · 3 active'],
      ['friend_nearby', 'Sarah nearby'],
    ])
    expect(card?.items[1]?.conversationId).toBe(presenceGroup(4)['conversationId'])
    expect(card?.items[1]?.groupId).toBe(presenceGroup(4)['groupId'])
    expect(card?.items[2]?.roomId).toBeNull()
    expect(card?.items[2]?.conversationId).toBeNull()
  })

  it('is null when nothing meaningful is happening', () => {
    expect(
      presenceCardFrom(
        parse({
          liveRooms: [
            liveRoom(1, {
              participants: [participant(2, { relationToViewer: 'other' })],
            }),
          ],
          activeGroups: [],
          nearbyFriends: [],
        }),
      ),
    ).toBeNull()
  })

  it('caps the row', () => {
    const card = presenceCardFrom(
      parse({
        nearbyFriends: Array.from({ length: PRESENCE_ITEMS_MAX + 3 }, (_, i) =>
          presenceNearbyFriend(100 + i, { displayName: `Friend ${i}` }),
        ),
      }),
    )
    expect(card?.items).toHaveLength(PRESENCE_ITEMS_MAX)
  })
})
