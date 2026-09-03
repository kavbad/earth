import { describe, expect, it } from 'vitest'

import {
  AUDIENCE,
  CLAIM_STATUSES,
  ENUM_REGISTRY,
  HUMAN_PASS_STATUS,
  HUMAN_STATUS,
  MEDIA_STATE,
  MESSAGE_TYPE,
  NOTIFICATION_TYPES,
  POSTGRES_ENUM_NAMES,
  REPORT_REASON,
  REPORT_REASON_HIGH_SEVERITY,
  REPORT_TARGET_TYPES,
  ROLE_KINDS,
  ROOM_JOIN_POLICY,
  ROOM_VISIBILITY,
  RoomVisibilitySchema,
  SCOPES,
  HumanStatusSchema,
} from './enums'

/** ARCHITECTURE §5 — the exact Postgres enum type names. */
const ARCHITECTURE_ENUM_NAMES = [
  'human_status',
  'human_pass_status',
  'relationship_type',
  'group_kind',
  'group_member_role',
  'group_member_status',
  'conversation_type',
  'message_type',
  'post_type',
  'audience',
  'reply_policy',
  'reshare_policy',
  'room_context_type',
  'room_visibility',
  'room_join_policy',
  'room_status',
  'area_precision',
  'participant_role',
  'media_state',
  'participant_status',
  'area_type',
  'location_audience_type',
  'location_precision',
  'notification_priority',
  'report_reason',
  'report_status',
  'media_provenance',
  'profile_visibility',
] as const

describe('ENUM_REGISTRY', () => {
  it('contains exactly the Postgres enum names from ARCHITECTURE §5', () => {
    expect([...POSTGRES_ENUM_NAMES].sort()).toEqual([...ARCHITECTURE_ENUM_NAMES].sort())
  })

  it('has no duplicate values inside any enum and no empty enums', () => {
    for (const [name, values] of Object.entries(ENUM_REGISTRY)) {
      expect(values.length, name).toBeGreaterThan(0)
      expect(new Set(values).size, `${name} has duplicates`).toBe(values.length)
    }
  })

  it('uses snake_case values only', () => {
    for (const values of Object.values(ENUM_REGISTRY)) {
      for (const value of values) expect(value).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it.each([
    ['human_status', ['pending', 'active', 'restricted', 'suspended', 'deleted']],
    ['human_pass_status', ['unverified', 'verifying', 'verified', 'review_required', 'rejected']],
    ['relationship_type', ['follow', 'friend_pending', 'friend', 'familiar_private']],
    ['group_kind', ['persistent', 'temporary']],
    ['group_member_role', ['owner', 'moderator', 'member']],
    ['group_member_status', ['active', 'left', 'removed']],
    ['conversation_type', ['direct', 'group']],
    [
      'message_type',
      ['text', 'image', 'video', 'audio', 'file', 'poll', 'system', 'place', 'plan'],
    ],
    ['post_type', ['text', 'image', 'video', 'moment']],
    ['audience', ['friends', 'neighborhood', 'city', 'world']],
    ['reply_policy', ['everyone_eligible', 'friends', 'mentioned', 'none']],
    ['reshare_policy', ['allowed_within_audience', 'none']],
    ['room_context_type', ['direct', 'group', 'event', 'place', 'standalone']],
    [
      'room_visibility',
      ['invited', 'group', 'friends', 'extended', 'neighborhood', 'city', 'world'],
    ],
    [
      'room_join_policy',
      [
        'invited_only',
        'group',
        'friends',
        'friends_of_friends',
        'request',
        'anyone_with_link',
        'anyone',
      ],
    ],
    ['room_status', ['starting', 'active', 'ending', 'ended']],
    ['area_precision', ['none', 'city', 'neighborhood', 'place']],
    ['participant_role', ['initiator', 'moderator', 'participant', 'viewer']],
    ['media_state', ['watching', 'audio', 'camera']],
    ['participant_status', ['invited', 'waiting', 'active', 'left', 'removed']],
    ['area_type', ['neighborhood', 'city', 'region', 'country']],
    ['location_audience_type', ['friend', 'group', 'temporary_context']],
    ['location_precision', ['city', 'approximate', 'precise']],
    ['notification_priority', ['critical_social', 'high', 'normal', 'low']],
    ['media_provenance', ['earth_capture', 'uploaded', 'edited', 'unknown']],
    ['profile_visibility', ['public', 'limited', 'hidden']],
  ] as const)('%s matches the spec values in order', (name, expected) => {
    expect(ENUM_REGISTRY[name]).toEqual(expected)
  })

  it('report_reason covers every spec §82 reason in order and flags the high-severity ones', () => {
    expect(REPORT_REASON).toEqual([
      'harassment',
      'threats',
      'hate',
      'sexual_content',
      'exploitation_minor_safety',
      'impersonation',
      'spam_scam',
      'nonconsensual_imagery',
      'dangerous_location_stalking',
      'violence',
      'other',
    ])
    for (const reason of REPORT_REASON_HIGH_SEVERITY) expect(REPORT_REASON).toContain(reason)
    expect(REPORT_REASON_HIGH_SEVERITY.has('other')).toBe(false)
  })
})

describe('supplementary tuples', () => {
  it('scopes equal the audience values (a radius browses an audience)', () => {
    expect([...SCOPES]).toEqual([...AUDIENCE])
  })

  it('role kinds match earth.current_role_kind()', () => {
    expect(ROLE_KINDS).toEqual(['visitor', 'guest', 'claiming', 'human', 'service'])
  })

  it('notification types match spec §86', () => {
    expect(NOTIFICATION_TYPES).toEqual([
      'direct_message',
      'group_message',
      'friend_live',
      'multi_live',
      'group_live',
      'friend_request',
      'friend_accepted',
      'follow',
      'group_invitation',
    ])
  })

  it('report target types cover every reportable surface of spec §81', () => {
    expect(REPORT_TARGET_TYPES).toEqual(['human', 'post', 'room', 'message', 'guest', 'group'])
  })

  it('claim statuses end in `claimed`, the value claim_get() returns for a Human (DB_API §1)', () => {
    expect(CLAIM_STATUSES).toEqual(['started', 'identity_set', 'verifying', 'verified', 'claimed'])
  })
})

describe('zod enums', () => {
  it('accept spec values and reject others', () => {
    expect(HumanStatusSchema.parse('active')).toBe('active')
    expect(HumanStatusSchema.safeParse('deactivated').success).toBe(false)
    expect(RoomVisibilitySchema.safeParse('public').success).toBe(false)
    expect(HUMAN_STATUS).toHaveLength(5)
    expect(HUMAN_PASS_STATUS).toHaveLength(5)
    expect(MESSAGE_TYPE).toHaveLength(9)
    expect(MEDIA_STATE).toHaveLength(3)
    expect(ROOM_VISIBILITY).toHaveLength(7)
    expect(ROOM_JOIN_POLICY).toHaveLength(7)
  })
})
