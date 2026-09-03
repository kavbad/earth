/**
 * The per-radius cache key, page merging, the presence/content split, list rows, impressions and
 * the UI reducer that follows the person across radii (SCREEN 01–05; spec §70, §110).
 */
import {
  type FeedPageDto,
  type FeedPostCardDto,
  type LiveCardDto,
  type PresenceCardDto,
  asAreaId,
  asConversationId,
  asHumanId,
  asPostId,
  asRoomId,
} from '@earth/domain'
import { describe, expect, it } from 'vitest'

import {
  areaIdForScope,
  authorRelationFor,
  cityChoices,
  feedOpenSource,
  feedQueryKey,
  feedRows,
  feedSubtitle,
  feedUiReducer,
  feedView,
  initialFeedUiState,
  mergeFeedPages,
  newlySeenKeys,
  presenceHref,
  selectedCityChoice,
  shouldShowAddPeople,
  viewerKeyFor,
} from './feed'

const MAYA = asHumanId('11111111-1111-4111-8111-111111111111')
const XAVIER = asHumanId('22222222-2222-4222-8222-222222222222')
const CITY = asAreaId('33333333-3333-4333-8333-333333333333')
const HOME_CITY = asAreaId('44444444-4444-4444-8444-444444444444')
const NOW = '2026-09-03T06:00:00.000Z'

function post(id: string, author = MAYA): FeedPostCardDto {
  const postId = asPostId(id)
  return {
    kind: 'post',
    id: postId,
    post: {
      id: postId,
      authorHumanId: author,
      type: 'text',
      text: 'hello',
      audience: 'friends',
      areaId: null,
      placeId: null,
      replyPolicy: 'everyone_eligible',
      resharePolicy: 'allowed_within_audience',
      parentPostId: null,
      rootPostId: null,
      createdAt: NOW,
      editedAt: null,
      deletedAt: null,
    },
    author: {
      humanId: author,
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
  }
}

function live(id: string): LiveCardDto {
  const roomId = asRoomId(id)
  return {
    kind: 'live',
    id: roomId,
    roomId,
    title: 'Xavier is live',
    participantNames: ['Xavier'],
    participantAvatars: [null],
    participantCount: 1,
    visibility: 'friends',
    contextTitle: null,
    startedAt: NOW,
    areaName: null,
  }
}

const presence: PresenceCardDto = {
  kind: 'presence',
  id: 'presence',
  items: [
    {
      type: 'friends_live',
      label: 'Xavier + Maya live',
      humanIds: [XAVIER, MAYA],
      roomId: asRoomId('55555555-5555-4555-8555-555555555555'),
      conversationId: null,
      groupId: null,
      avatarUrls: [],
    },
  ],
}

const P1 = '66666666-6666-4666-8666-666666666661'
const P2 = '66666666-6666-4666-8666-666666666662'
const P3 = '66666666-6666-4666-8666-666666666663'
const L1 = '77777777-7777-4777-8777-777777777771'

function page(cards: FeedPageDto['cards'], nextCursor: string | null = null): FeedPageDto {
  return { cards, nextCursor, snapshotAt: NOW, scope: 'friends', areaName: 'North Beach' }
}

describe('feed cache keys (per viewer × radius × area)', () => {
  it('visitors share one key; humans get their own', () => {
    expect(viewerKeyFor(null)).toBe('visitor')
    expect(viewerKeyFor(MAYA)).toBe(MAYA)
    expect(feedQueryKey('friends', null, 'visitor')).toEqual(['feed', 'visitor', 'friends', null])
    expect(feedQueryKey('city', CITY, MAYA)).toEqual(['feed', MAYA, 'city', CITY])
    expect(feedQueryKey('city', CITY, MAYA)).not.toEqual(feedQueryKey('city', HOME_CITY, MAYA))
  })

  it('only City honours an explicit area', () => {
    expect(areaIdForScope('city', CITY)).toBe(CITY)
    expect(areaIdForScope('neighborhood', CITY)).toBeNull()
    expect(areaIdForScope('world', CITY)).toBeNull()
  })
})

describe('mergeFeedPages / feedView', () => {
  it('keeps the server order and drops duplicate ids from an overlapping refresh', () => {
    const cards = mergeFeedPages([
      page([presence, post(P1), live(L1)], 'c1'),
      page([post(P1), post(P2)]),
    ])
    expect(cards.map((card) => card.id)).toEqual(['presence', P1, L1, P2])
  })

  it('splits presence from content, drops hidden posts and reads the area name', () => {
    const view = feedView([page([presence, post(P1), live(L1), post(P2)])], new Set([P2]))
    expect(view.presence.map((item) => item.label)).toEqual(['Xavier + Maya live'])
    expect(view.cards.map((card) => card.id)).toEqual([P1, L1])
    expect(view.areaName).toBe('North Beach')
  })

  it('is empty without pages', () => {
    expect(feedView([])).toEqual({ presence: [], cards: [], areaName: null })
  })

  it('rows carry a stable key and position', () => {
    const rows = feedRows(feedView([page([post(P1), live(L1)])]).cards)
    expect(rows).toEqual([
      { key: `post:${P1}`, card: expect.objectContaining({ id: P1 }), position: 0 },
      { key: `live:${L1}`, card: expect.objectContaining({ id: L1 }), position: 1 },
    ])
  })
})

describe('impressions', () => {
  it('reports each card once, in order, without duplicates', () => {
    expect(newlySeenKeys(new Set(['a']), ['a', 'b', 'c', 'b'])).toEqual(['b', 'c'])
    expect(newlySeenKeys(new Set(['a', 'b']), ['a', 'b'])).toEqual([])
  })

  it('author relation is self only for the viewer', () => {
    expect(authorRelationFor(MAYA, MAYA)).toBe('self')
    expect(authorRelationFor(XAVIER, MAYA)).toBe('other')
    expect(authorRelationFor(null, MAYA)).toBe('other')
  })
})

describe('feedUiReducer', () => {
  it('hides once, unhides, and keeps the same state for no-ops', () => {
    const start = initialFeedUiState('visitor')
    const hidden = feedUiReducer(start, { type: 'hide', postId: P1 })
    expect(hidden.hiddenPostIds).toEqual([P1])
    expect(feedUiReducer(hidden, { type: 'hide', postId: P1 })).toBe(hidden)
    const shown = feedUiReducer(hidden, { type: 'unhide', postId: P1 })
    expect(shown.hiddenPostIds).toEqual([])
    expect(feedUiReducer(shown, { type: 'unhide', postId: P3 })).toBe(shown)
  })

  it('remembers the chosen City and resets everything when the viewer changes', () => {
    const state = feedUiReducer(
      feedUiReducer(initialFeedUiState(MAYA), { type: 'select_city', areaId: HOME_CITY }),
      { type: 'hide', postId: P1 },
    )
    expect(state.cityAreaId).toBe(HOME_CITY)
    expect(feedUiReducer(state, { type: 'select_city', areaId: HOME_CITY })).toBe(state)
    expect(feedUiReducer(state, { type: 'viewer_changed', viewerKey: MAYA })).toBe(state)
    expect(feedUiReducer(state, { type: 'viewer_changed', viewerKey: XAVIER })).toEqual(
      initialFeedUiState(XAVIER),
    )
  })
})

describe('city switch (SCREEN 04)', () => {
  const context = {
    currentAreaId: null,
    currentAreaName: 'North Beach',
    currentCityId: CITY,
    currentCityName: 'San Francisco',
    homeCityId: HOME_CITY,
  }

  it('offers the current city and a different home city, once each', () => {
    expect(cityChoices(context, 'Los Angeles')).toEqual([
      { kind: 'current', areaId: CITY, name: 'San Francisco' },
      { kind: 'home', areaId: HOME_CITY, name: 'Los Angeles' },
    ])
    expect(cityChoices({ ...context, homeCityId: CITY }, 'San Francisco')).toHaveLength(1)
    expect(cityChoices(null, 'Los Angeles')).toEqual([])
  })

  it('selects the current city by default and the chosen one otherwise', () => {
    const choices = cityChoices(context, 'Los Angeles')
    expect(selectedCityChoice(choices, null)?.kind).toBe('current')
    expect(selectedCityChoice(choices, HOME_CITY)?.name).toBe('Los Angeles')
  })

  it('subtitles Neighborhood and a switch-less City, nothing else', () => {
    expect(feedSubtitle({ scope: 'neighborhood', areaName: null, context, choiceCount: 2 })).toBe(
      'North Beach',
    )
    expect(feedSubtitle({ scope: 'city', areaName: null, context, choiceCount: 1 })).toBe(
      'San Francisco',
    )
    expect(feedSubtitle({ scope: 'city', areaName: null, context, choiceCount: 2 })).toBeUndefined()
    expect(
      feedSubtitle({ scope: 'friends', areaName: 'x', context, choiceCount: 1 }),
    ).toBeUndefined()
  })
})

describe('analytics and the zero-friends row', () => {
  it('feed_opened source', () => {
    expect(feedOpenSource(false, false)).toBe('launch')
    expect(feedOpenSource(true, false)).toBe('tab')
    expect(feedOpenSource(true, true)).toBe('refresh')
  })

  it('shows "Add people you actually know" only to a friendless Human on Friends', () => {
    expect(shouldShowAddPeople({ isHuman: true, scope: 'friends', friendCount: 0 })).toBe(true)
    expect(shouldShowAddPeople({ isHuman: true, scope: 'world', friendCount: 0 })).toBe(false)
    expect(shouldShowAddPeople({ isHuman: false, scope: 'friends', friendCount: 0 })).toBe(false)
    expect(shouldShowAddPeople({ isHuman: true, scope: 'friends', friendCount: null })).toBe(false)
  })
})

describe('presence row (SCREEN 02)', () => {
  it('a Live opens its room, a group its conversation, "nearby" nothing', () => {
    const item = presence.items[0]
    if (item === undefined) throw new Error('fixture')
    expect(presenceHref(item)).toBe(`/rooms/${item.roomId}`)
    expect(
      presenceHref({
        ...item,
        type: 'group_active',
        roomId: null,
        conversationId: asConversationId('99999999-9999-4999-8999-999999999999'),
      }),
    ).toBe('/chats/99999999-9999-4999-8999-999999999999')
    expect(
      presenceHref({ ...item, type: 'friend_nearby', roomId: null, conversationId: null }),
    ).toBeNull()
  })
})
