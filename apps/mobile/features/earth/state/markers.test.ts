import { fixtures } from '@earth/api/testing'
import { LiveCardDtoSchema, MapObjectsDtoSchema } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import {
  activeFriends,
  friendHaloPt,
  isAreaLevel,
  liveMarker,
  liveMarkerId,
  positionsOf,
  toMarkers,
} from './markers'

const objects = (overrides: Parameters<typeof fixtures.mapObjects>[0] = {}) =>
  MapObjectsDtoSchema.parse(fixtures.mapObjects(overrides))

const liveCard = () =>
  LiveCardDtoSchema.parse({
    kind: 'live',
    id: fixtures.IDS.room,
    roomId: fixtures.IDS.room,
    title: 'Xavier is live',
    participantNames: ['Xavier', 'Maya'],
    participantAvatars: [fixtures.AVATAR, null],
    participantCount: 2,
    visibility: 'city',
    contextTitle: null,
    startedAt: fixtures.AT,
    areaName: 'Mission',
  })

describe('toMarkers (SCREEN 20)', () => {
  it('maps every kind and keeps exactly the coordinates the server gave', () => {
    const dto = objects()
    const markers = toMarkers(dto)
    expect(markers.lives).toHaveLength(1)
    expect(markers.places).toHaveLength(1)
    expect(markers.friends).toHaveLength(1)
    expect(markers.moments).toHaveLength(1)
    const live = markers.lives[0]!
    expect(live.position).toEqual({ lat: dto.lives[0]!.lat, lng: dto.lives[0]!.lng })
    expect(live.id).toBe(liveMarkerId(fixtures.IDS.room))
    expect(live.precision).toBe('neighborhood')
    expect(isAreaLevel(live)).toBe(true)
    expect(markers.friends[0]!.precision).toBe('approximate')
    expect(markers.moments[0]!.authorDisplayName).toBe('Xavier')
    expect(positionsOf(markers)).toHaveLength(4)
  })

  it('never emits a marker for a Live without an area position (precision none)', () => {
    const dto = objects({
      lives: [
        {
          roomId: fixtures.IDS.room,
          title: 'Xavier is live',
          lat: 37.76,
          lng: -122.42,
          precision: 'none',
          participantCount: 1,
        },
      ],
    })
    expect(toMarkers(dto).lives).toEqual([])
    expect(liveMarker(dto.lives[0]!, new Map())).toBeNull()
  })

  it('never carries a device coordinate for a Live: only the server position, at area level or a Place', () => {
    const dto = objects({
      lives: [
        {
          roomId: fixtures.IDS.room,
          title: 'Weekend Crew is live',
          lat: 37.7596,
          lng: -122.4269,
          precision: 'place',
          participantCount: 3,
        },
      ],
    })
    const [live] = toMarkers(dto).lives
    expect(live!.precision).toBe('place')
    expect(isAreaLevel(live!)).toBe(false)
    // A Live marker knows nothing but the server's reduced position: no raw lat/lng fields.
    expect(Object.keys(live!).sort()).toEqual(
      [
        'faces',
        'id',
        'kind',
        'participantCount',
        'position',
        'precision',
        'roomId',
        'title',
      ].sort(),
    )
    expect(live!.position).toEqual({ lat: 37.7596, lng: -122.4269 })
  })

  it('adds faces from the Live list by room id and none otherwise', () => {
    const withFaces = toMarkers(objects(), [liveCard()])
    expect(withFaces.lives[0]!.faces).toEqual([
      { displayName: 'Xavier', avatarUrl: fixtures.AVATAR },
      { displayName: 'Maya', avatarUrl: null },
    ])
    expect(toMarkers(objects()).lives[0]!.faces).toEqual([])
  })

  it('drops expired friend shares and sizes the precision ring by precision', () => {
    const markers = toMarkers(objects())
    const friend = markers.friends[0]!
    expect(activeFriends([friend], new Date(friend.expiresAt).getTime() - 1)).toHaveLength(1)
    expect(activeFriends([friend], new Date(friend.expiresAt).getTime() + 1)).toHaveLength(0)
    expect(friendHaloPt('city')).toBeGreaterThan(friendHaloPt('approximate'))
    expect(friendHaloPt('precise')).toBe(0)
  })
})
