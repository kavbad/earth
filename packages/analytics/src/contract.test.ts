import { describe, expect, it } from 'vitest'

import {
  categoryOfEvent,
  EVENT_CATEGORIES,
  EVENT_CATEGORY_NAMES,
  EVENT_MAP_HAS_NO_BASE_KEYS,
  EVENT_MAP_IS_COMPLETE,
  EVENT_MAP_OVERRIDES_ONLY_GUEST_SESSION,
  EVENT_NAMES,
  isEventName,
} from './contract'

/** Verbatim from EARTH_V1_SPEC.md §97 — the contract must cover every one of these. */
const SPEC_EVENTS = {
  membership: [
    'public_world_viewed',
    'claim_started',
    'claim_group_join_selected',
    'claim_group_start_selected',
    'human_verification_started',
    'human_verification_passed',
    'human_verification_failed',
    'human_claimed',
    'account_recovery_started',
  ],
  groups: [
    'group_created',
    'group_invite_shared',
    'group_invite_opened',
    'group_joined',
    'group_left',
    'second_group_joined',
  ],
  messaging: [
    'message_sent',
    'message_received',
    'message_replied',
    'reaction_added',
    'voice_message_sent',
    'media_message_sent',
  ],
  video_live: [
    'room_created',
    'room_joined',
    'room_left',
    'camera_enabled',
    'audio_joined',
    'room_visibility_changed',
    'live_card_impression',
    'live_card_opened',
    'live_join_requested',
    'participant_consent_shown',
    'participant_consent_accepted',
    'guest_room_opened',
    'guest_joined',
    'guest_room_completed',
  ],
  feed: [
    'feed_opened',
    'scope_changed',
    'post_impression',
    'post_opened',
    'post_created',
    'post_reacted',
    'post_replied',
    'post_hidden',
  ],
  social: [
    'friend_requested',
    'friend_accepted',
    'follow_created',
    'profile_viewed',
    'search_performed',
  ],
  safety: ['human_blocked', 'content_reported', 'room_participant_removed', 'guest_removed'],
} as const

const ALL_SPEC_EVENTS = Object.values(SPEC_EVENTS).flat()

describe('EVENT_NAMES', () => {
  it('contains every event required by spec §97', () => {
    for (const event of ALL_SPEC_EVENTS) {
      expect(EVENT_NAMES, event).toContain(event)
    }
  })

  it('contains nothing beyond the spec list and no duplicates', () => {
    expect([...EVENT_NAMES].sort()).toEqual([...ALL_SPEC_EVENTS].sort())
    expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length)
    expect(EVENT_NAMES).toHaveLength(52)
  })

  it('lists events in spec order (stable for dashboards and fixtures)', () => {
    expect([...EVENT_NAMES]).toEqual(ALL_SPEC_EVENTS)
  })

  it('groups events exactly as the spec does', () => {
    expect(EVENT_CATEGORIES.membership).toEqual(SPEC_EVENTS.membership)
    expect(EVENT_CATEGORIES.groups).toEqual(SPEC_EVENTS.groups)
    expect(EVENT_CATEGORIES.messaging).toEqual(SPEC_EVENTS.messaging)
    expect(EVENT_CATEGORIES.live).toEqual(SPEC_EVENTS.video_live)
    expect(EVENT_CATEGORIES.feed).toEqual(SPEC_EVENTS.feed)
    expect(EVENT_CATEGORIES.social).toEqual(SPEC_EVENTS.social)
    expect(EVENT_CATEGORIES.safety).toEqual(SPEC_EVENTS.safety)
    expect(EVENT_CATEGORY_NAMES).toEqual([
      'membership',
      'groups',
      'messaging',
      'live',
      'feed',
      'social',
      'safety',
    ])
  })

  it('uses snake_case names only', () => {
    for (const event of EVENT_NAMES) expect(event).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/)
  })

  it('resolves the category of every event', () => {
    expect(categoryOfEvent('room_joined')).toBe('live')
    expect(categoryOfEvent('guest_removed')).toBe('safety')
    for (const event of EVENT_NAMES) expect(EVENT_CATEGORY_NAMES).toContain(categoryOfEvent(event))
  })

  it('isEventName narrows strings', () => {
    expect(isEventName('scope_changed')).toBe(true)
    expect(isEventName('page_view')).toBe(false)
    expect(isEventName(42)).toBe(false)
  })

  it('exports the compile-time contract assertions', () => {
    // These constants only exist when their `satisfies` clauses typecheck (see contract.ts).
    expect(EVENT_MAP_IS_COMPLETE).toBe(true)
    expect(EVENT_MAP_HAS_NO_BASE_KEYS).toBe(true)
    expect(EVENT_MAP_OVERRIDES_ONLY_GUEST_SESSION).toBe(true)
  })
})
