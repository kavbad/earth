import { fixtures } from '@earth/api/testing'
import {
  type AreaId,
  type FeedPageDto,
  FeedPageDtoSchema,
  type HumanContextDto,
} from '@earth/domain'
import { describe, expect, it } from 'vitest'

import {
  VISITOR_KEY,
  areaIdForScope,
  cityChoices,
  feedIsLoading,
  feedOpenSource,
  feedQueryKey,
  feedUiReducer,
  feedView,
  initialFeedUiState,
  mergeFeedPages,
  shouldShowAddPeople,
  viewerKeyFor,
} from './feed'

const CITY = fixtures.IDS.city as AreaId
const HOME = '99999999-9999-4999-8999-999999999999' as AreaId

function page(overrides: Parameters<typeof fixtures.feedPage>[0] = {}): FeedPageDto {
  return FeedPageDtoSchema.parse(fixtures.feedPage(overrides))
}

function presencePage(): FeedPageDto {
  return page({
    cards: [
      {
        kind: 'presence',
        id: 'presence',
        items: [
          {
            type: 'friends_live',
            label: 'Xavier + Maya live',
            humanIds: [fixtures.IDS.xavier, fixtures.IDS.maya],
            roomId: fixtures.IDS.room,
            conversationId: null,
            groupId: null,
            avatarUrls: [],
          },
        ],
      },
      { kind: 'post', id: fixtures.IDS.post, ...fixtures.postView() },
      fixtures.liveCard(),
    ],
  })
}

describe('feed cache (SCREEN 01–05)', () => {
  it('keys the cache per viewer, radius and area', () => {
    expect(feedQueryKey('friends', null, viewerKeyFor(null))).toEqual([
      'feed',
      VISITOR_KEY,
      'friends',
      null,
    ])
    expect(feedQueryKey('city', CITY, viewerKeyFor(fixtures.IDS.xavier))).toEqual([
      'feed',
      fixtures.IDS.xavier,
      'city',
      CITY,
    ])
  })

  it('merges pages without duplicating a card that reappears after the cursor', () => {
    const first = page()
    const second = page({ cards: [first.cards[0]!, fixtures.liveCard({ id: fixtures.IDS.room })] })
    const merged = mergeFeedPages([first, second])
    expect(merged.map((card) => card.id)).toEqual([fixtures.IDS.post, fixtures.IDS.room])
  })

  it('splits presence from content, drops hidden posts and carries the area name', () => {
    const view = feedView([presencePage()], new Set([fixtures.IDS.post]))
    expect(view.presence.map((item) => item.label)).toEqual(['Xavier + Maya live'])
    expect(view.cards.map((card) => card.kind)).toEqual(['live'])
    expect(feedView([page({ areaName: 'North Beach' })]).areaName).toBe('North Beach')
    expect(feedView([]).presence).toEqual([])
  })
})

describe('feed UI reducer', () => {
  const initial = initialFeedUiState(VISITOR_KEY)

  it('hides and unhides posts idempotently', () => {
    const hidden = feedUiReducer(initial, { type: 'hide', postId: 'a' })
    expect(hidden.hiddenPostIds).toEqual(['a'])
    expect(feedUiReducer(hidden, { type: 'hide', postId: 'a' })).toBe(hidden)
    expect(feedUiReducer(hidden, { type: 'unhide', postId: 'a' }).hiddenPostIds).toEqual([])
    expect(feedUiReducer(initial, { type: 'unhide', postId: 'a' })).toBe(initial)
  })

  it('keeps the chosen city only for the City radius and resets for a new viewer', () => {
    const chosen = feedUiReducer(initial, { type: 'select_city', areaId: HOME })
    expect(areaIdForScope('city', chosen.cityAreaId)).toBe(HOME)
    expect(areaIdForScope('neighborhood', chosen.cityAreaId)).toBeNull()
    expect(feedUiReducer(chosen, { type: 'viewer_changed', viewerKey: VISITOR_KEY })).toBe(chosen)
    expect(feedUiReducer(chosen, { type: 'viewer_changed', viewerKey: 'human' })).toEqual(
      initialFeedUiState('human'),
    )
  })
})

describe('city choices and Home helpers', () => {
  const context: HumanContextDto = {
    currentAreaId: null,
    currentAreaName: null,
    currentCityId: CITY,
    currentCityName: 'San Francisco',
    homeCityId: HOME,
  }

  it('offers the current city and a different home city', () => {
    expect(cityChoices(context, 'Oakland')).toEqual([
      { kind: 'current', areaId: CITY, name: 'San Francisco' },
      { kind: 'home', areaId: HOME, name: 'Oakland' },
    ])
    expect(cityChoices({ ...context, homeCityId: CITY }, 'San Francisco')).toHaveLength(1)
    expect(cityChoices(context, null)).toHaveLength(1)
    expect(cityChoices(null, 'Oakland')).toEqual([])
  })

  it('names the feed_opened source and the zero-friends state', () => {
    expect(feedOpenSource(false, false)).toBe('launch')
    expect(feedOpenSource(true, false)).toBe('tab')
    expect(feedOpenSource(true, true)).toBe('refresh')
    expect(shouldShowAddPeople({ isHuman: true, scope: 'friends', friendCount: 0 })).toBe(true)
    expect(shouldShowAddPeople({ isHuman: true, scope: 'world', friendCount: 0 })).toBe(false)
    expect(shouldShowAddPeople({ isHuman: false, scope: 'friends', friendCount: 0 })).toBe(false)
    expect(shouldShowAddPeople({ isHuman: true, scope: 'friends', friendCount: null })).toBe(false)
  })
})

describe('feedIsLoading (spec §92, §107)', () => {
  it('keeps the placeholder while the shell settles, so Home never claims the radius is empty', () => {
    expect(feedIsLoading({ scopeOpen: true, shellReady: false, queryPending: true })).toBe(true)
    // A query that has not been allowed to start reports `isPending`; so does a first fetch.
    expect(feedIsLoading({ scopeOpen: true, shellReady: true, queryPending: true })).toBe(true)
  })

  it('stops once the first page has answered', () => {
    expect(feedIsLoading({ scopeOpen: true, shellReady: true, queryPending: false })).toBe(false)
  })

  it('never loads a radius that is not open to this person', () => {
    expect(feedIsLoading({ scopeOpen: false, shellReady: false, queryPending: true })).toBe(false)
    expect(feedIsLoading({ scopeOpen: false, shellReady: true, queryPending: true })).toBe(false)
  })
})
