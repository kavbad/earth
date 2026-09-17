/**
 * SCREEN 21 rows: the four sections in the spec's order, headers only for non-empty sections,
 * stable keys, and the count `search_performed` reports.
 */
import { type SearchResultsDto, asGroupId, asHumanId, asPlaceId, asPostId } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { resultCount, searchRows } from './search'

const MAYA = asHumanId('11111111-1111-4111-8111-111111111111')
const GROUP = asGroupId('44444444-4444-4444-8444-444444444444')
const PLACE = asPlaceId('55555555-5555-4555-8555-555555555555')
const POST = asPostId('66666666-6666-4666-8666-666666666666')

const results: SearchResultsDto = {
  people: [
    {
      humanId: MAYA,
      displayName: 'Maya',
      handle: 'maya',
      avatarUrl: null,
      mutualFriendCount: 8,
      cityName: 'San Francisco',
      isFriend: false,
      isFollowing: true,
    },
  ],
  groups: [
    { groupId: GROUP, name: 'Weekend Crew', avatarUrl: null, memberCount: 6, isMember: true },
  ],
  places: [
    {
      placeId: PLACE,
      name: 'Dolores Park',
      areaName: 'Mission',
      lat: 37.76,
      lng: -122.43,
      category: null,
    },
  ],
  posts: [
    {
      post: {
        id: POST,
        authorHumanId: MAYA,
        type: 'text',
        text: 'hello',
        audience: 'world',
        areaId: null,
        placeId: null,
        replyPolicy: 'everyone_eligible',
        resharePolicy: 'allowed_within_audience',
        parentPostId: null,
        rootPostId: null,
        createdAt: '2026-09-03T06:00:00.000Z',
        editedAt: null,
        deletedAt: null,
      },
      author: {
        humanId: MAYA,
        displayName: 'Maya',
        handle: 'maya',
        avatarUrl: null,
        bio: null,
        cityName: null,
        profileVisibility: 'public',
      },
      reactionCount: 0,
      replyCount: 0,
      myReaction: null,
      place: null,
      media: [],
    },
  ],
}

describe('searchRows', () => {
  it('lists the sections in the spec order, each headed once', () => {
    expect(searchRows(results).map((row) => row.key)).toEqual([
      'header:people',
      `person:${MAYA}`,
      'header:groups',
      `group:${GROUP}`,
      'header:places',
      `place:${PLACE}`,
      'header:posts',
      `post:${POST}`,
    ])
  })

  it('skips empty sections and their headers', () => {
    const rows = searchRows({ ...results, groups: [], posts: [] })
    expect(rows.map((row) => row.kind)).toEqual(['header', 'person', 'header', 'place'])
    expect(searchRows({ people: [], groups: [], places: [], posts: [] })).toEqual([])
  })

  it('counts every result across sections (never the text)', () => {
    expect(resultCount(results)).toBe(4)
    expect(resultCount({ ...results, people: [] })).toBe(3)
  })
})
