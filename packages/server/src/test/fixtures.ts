/**
 * Deterministic feed / live / notification fixtures for server tests.
 */
import { type FeedCandidate, type PostViewDto, PostViewDtoSchema } from '@earth/domain'

import type { LiveParticipantRow, LiveRoomRow } from '../feed/rows'
import type { UnsentNotificationRow } from '../push/messages'

export const T0 = Date.UTC(2026, 8, 3, 12, 0, 0)

export function uuidAt(n: number, prefix = '00000000-0000-4000-8000'): string {
  return `${prefix}-${n.toString(16).padStart(12, '0')}`
}

export function hoursBefore(hours: number, base: number = T0): string {
  return new Date(base - hours * 3_600_000).toISOString()
}

export const AUTHOR_PREFIX = '10000000-0000-4000-8000'
export const ROOM_PREFIX = '20000000-0000-4000-8000'
export const PARTICIPANT_PREFIX = '30000000-0000-4000-8000'

export function postView(n: number, overrides: Partial<PostViewDto['post']> = {}): PostViewDto {
  const authorHumanId = uuidAt(n, AUTHOR_PREFIX)
  return PostViewDtoSchema.parse({
    post: {
      id: uuidAt(n),
      authorHumanId,
      type: 'text',
      text: `post ${n}`,
      audience: 'world',
      areaId: null,
      placeId: null,
      replyPolicy: 'everyone_eligible',
      resharePolicy: 'allowed_within_audience',
      parentPostId: null,
      rootPostId: null,
      createdAt: hoursBefore(n),
      editedAt: null,
      deletedAt: null,
      ...overrides,
    },
    author: {
      humanId: authorHumanId,
      displayName: `Author ${n}`,
      handle: `author${n}`,
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
  })
}

export function postCandidate(n: number, overrides: Partial<FeedCandidate> = {}): FeedCandidate {
  return {
    kind: 'post',
    id: uuidAt(n),
    authorHumanId: uuidAt(n, AUTHOR_PREFIX),
    createdAt: hoursBefore(n),
    startedAt: null,
    relationship: 'none',
    sharedGroupCount: 0,
    isLive: false,
    liveParticipantCount: 0,
    liveFriendCount: 0,
    reactionCount: 0,
    replyCount: 0,
    authorPostCountRecent: 1,
    interestMatch: 0,
    placeAffinity: 0,
    hasSeen: false,
    audience: 'world',
    areaId: null,
    ...overrides,
  }
}

/** A `feed_candidates` row for a post: features + `post` payload. */
export function postRow(
  n: number,
  overrides: Partial<FeedCandidate> = {},
): Record<string, unknown> {
  return { ...postCandidate(n, overrides), post: postView(n), live: null }
}

export function participant(
  n: number,
  overrides: Partial<LiveParticipantRow> = {},
): LiveParticipantRow {
  return {
    id: uuidAt(n, PARTICIPANT_PREFIX),
    displayName: `Person ${n}`,
    avatarUrl: null,
    isGuest: false,
    mediaState: 'camera',
    status: 'active',
    relationToViewer: 'other',
    joinedAt: hoursBefore(0.5),
    ...overrides,
  }
}

export function liveRoom(n: number, overrides: Partial<LiveRoomRow> = {}): LiveRoomRow {
  return {
    roomId: uuidAt(n, ROOM_PREFIX) as LiveRoomRow['roomId'],
    contextType: 'standalone',
    contextTitle: null,
    title: null,
    visibility: 'friends',
    startedAt: hoursBefore(0.25),
    areaName: null,
    participants: [participant(n, { displayName: 'Xavier', relationToViewer: 'friend' })],
    ...overrides,
  }
}

/** A `feed_candidates` row for a Live: features + `live` payload. */
export function liveRow(
  n: number,
  room: Partial<LiveRoomRow> = {},
  overrides: Partial<FeedCandidate> = {},
): Record<string, unknown> {
  const live = liveRoom(n, room)
  return {
    ...postCandidate(n, {
      kind: 'live',
      id: live.roomId,
      authorHumanId: null,
      createdAt: live.startedAt,
      startedAt: live.startedAt,
      isLive: true,
      liveParticipantCount: live.participants.length,
      liveFriendCount: live.participants.filter((p) => p.relationToViewer === 'friend').length,
      audience: 'friends',
      ...overrides,
    }),
    post: null,
    live,
  }
}

export const RECIPIENT_A = '41111111-1111-4111-8111-111111111111'
export const RECIPIENT_B = '42222222-2222-4222-8222-222222222222'
export const CONVERSATION_ID = '51111111-1111-4111-8111-111111111111'
export const ROOM_ID = '61111111-1111-4111-8111-111111111111'

export function notification(
  n: number,
  overrides: Partial<UnsentNotificationRow> = {},
): UnsentNotificationRow {
  return {
    id: uuidAt(n, '70000000-0000-4000-8000'),
    recipientHumanId: RECIPIENT_A,
    type: 'direct_message',
    priority: 'high',
    actorHumanId: null,
    objectType: 'message',
    objectId: uuidAt(n, '80000000-0000-4000-8000'),
    payload: { senderName: 'Xavier', preview: `hey ${n}`, conversationId: CONVERSATION_ID },
    createdAt: hoursBefore(0.1),
    pushTokens: [{ token: `ExponentPushToken[a${n}]`, platform: 'ios' }],
    presence: null,
    ...overrides,
  }
}
