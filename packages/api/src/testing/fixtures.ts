/**
 * Wire-shaped DTO fixtures (camelCase JSON exactly as RPCs and routes return it) for tests of this
 * package and of everything built on `EarthClient`. Each builder returns a fresh object; pass
 * overrides to vary a case. Ids are valid v4 uuids so branded id schemas accept them.
 */
import type {
  AreaDtoSchema,
  BlocksListDtoSchema,
  ClaimCompleteDtoSchema,
  ClaimStateDtoSchema,
  ConversationDetailDtoSchema,
  ConversationSummaryDtoSchema,
  FeedPageDtoSchema,
  FlagsDtoSchema,
  GroupDetailDtoSchema,
  GroupDtoSchema,
  GroupInviteCreateDtoSchema,
  GroupInvitePreviewDtoSchema,
  GroupJoinDtoSchema,
  GroupMemberDtoSchema,
  GuestSessionDtoSchema,
  HumanContextDtoSchema,
  LiveCardDtoSchema,
  LiveListDtoSchema,
  LocationShareDtoSchema,
  MapFriendDtoSchema,
  MapObjectsDtoSchema,
  MeDtoSchema,
  MessageDtoSchema,
  MessagesPageDtoSchema,
  NotificationDtoSchema,
  NotificationsPageDtoSchema,
  PlaceDtoSchema,
  PostDetailDtoSchema,
  PostDtoSchema,
  PostViewDtoSchema,
  ProfileDtoSchema,
  PublicIdentityDtoSchema,
  RelationshipChangeDtoSchema,
  ReportDtoSchema,
  RoomDtoSchema,
  RoomInviteCreateDtoSchema,
  RoomInvitePreviewDtoSchema,
  RoomLeaveDtoSchema,
  RoomParticipantDtoSchema,
  RoomStartDtoSchema,
  RoomTokenDtoSchema,
  RoomVisibilityChangeDtoSchema,
  SearchResultsDtoSchema,
  VerificationSessionDtoSchema,
} from '@earth/domain'
import type { z } from 'zod'

import type {
  AreaResolutionDtoSchema,
  BlockChangeDtoSchema,
  ConversationPrefsDtoSchema,
  ConversationsPageDtoSchema,
  FeatureFlagRowSchema,
  GroupInviteRevokeDtoSchema,
  GroupInviteRowSchema,
  GroupLeaveDtoSchema,
  GroupMemberRemoveDtoSchema,
  GuestSessionsDtoSchema,
  IdentityReviewDtoSchema,
  MediaObjectRowSchema,
  ReadReceiptDtoSchema,
  VerificationBeginDtoSchema,
  VerificationResultDtoSchema,
} from '../dto'

type Input<S extends z.ZodType> = z.input<S>
type Overrides<S extends z.ZodType> = Partial<Input<S>>

/** Fixture ids (valid v4 uuids). */
export const IDS = {
  xavier: '11111111-1111-4111-8111-111111111111',
  maya: '22222222-2222-4222-8222-222222222222',
  kavon: '33333333-3333-4333-8333-333333333333',
  group: '44444444-4444-4444-8444-444444444444',
  conversation: '55555555-5555-4555-8555-555555555555',
  message: '66666666-6666-4666-8666-666666666666',
  room: '77777777-7777-4777-8777-777777777777',
  post: '88888888-8888-4888-8888-888888888888',
  guest: '99999999-9999-4999-8999-999999999999',
  area: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  city: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  place: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  notification: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  participant: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  client: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  invite: '12121212-1212-4121-8121-121212121212',
  share: '13131313-1313-4131-8131-131313131313',
  review: '14141414-1414-4141-8141-141414141414',
  media: '15151515-1515-4151-8151-151515151515',
  report: '16161616-1616-4161-8161-161616161616',
  reply: '17171717-1717-4171-8171-171717171717',
  message2: '18181818-1818-4181-8181-181818181818',
} as const

export const AT = '2026-09-03T06:00:00.123456+00:00'
export const LATER = '2026-09-03T08:00:00+00:00'
export const AVATAR = 'https://cdn.earth.social/avatars/xavier.jpg'
export const ORIGIN = 'https://earth.social'

export function identity(
  overrides: Overrides<typeof PublicIdentityDtoSchema> = {},
): Input<typeof PublicIdentityDtoSchema> {
  return {
    humanId: IDS.xavier,
    displayName: 'Xavier',
    handle: 'xavier',
    avatarUrl: AVATAR,
    bio: null,
    cityName: 'San Francisco',
    profileVisibility: 'public',
    ...overrides,
  }
}

export function humanContext(
  overrides: Overrides<typeof HumanContextDtoSchema> = {},
): Input<typeof HumanContextDtoSchema> {
  return {
    currentAreaId: IDS.area,
    currentAreaName: 'Mission',
    currentCityId: IDS.city,
    currentCityName: 'San Francisco',
    homeCityId: IDS.city,
    ...overrides,
  }
}

export function flagsDto(): Input<typeof FlagsDtoSchema> {
  return {
    GROUP_ANCHORED_CLAIM_REQUIRED: { enabled: true, payload: null, updatedAt: AT },
    PUBLIC_WORLD_ENABLED: { enabled: true, payload: { note: 'launch' }, updatedAt: AT },
    MAFIA_ACTIVITY_ENABLED: { enabled: false, payload: null, updatedAt: AT },
  }
}

export function featureFlagRow(
  overrides: Overrides<typeof FeatureFlagRowSchema> = {},
): Input<typeof FeatureFlagRowSchema> {
  return { key: 'PUBLIC_WORLD_ENABLED', enabled: true, payload: null, updated_at: AT, ...overrides }
}

export function meDto(overrides: Overrides<typeof MeDtoSchema> = {}): Input<typeof MeDtoSchema> {
  return {
    roleKind: 'human',
    humanId: IDS.xavier,
    identity: identity(),
    humanStatus: 'active',
    humanPassStatus: 'verified',
    context: humanContext(),
    flags: flagsDto(),
    ...overrides,
  }
}

export function claimState(
  overrides: Overrides<typeof ClaimStateDtoSchema> = {},
): Input<typeof ClaimStateDtoSchema> {
  return {
    status: 'identity_set',
    intent: 'start_group',
    groupLabel: 'Weekend Crew',
    identity: { displayName: 'Xavier', handle: 'xavier', avatarUrl: AVATAR },
    verification: { status: 'unverified' },
    humanId: IDS.xavier,
    ...overrides,
  }
}

export function claimComplete(
  overrides: Overrides<typeof ClaimCompleteDtoSchema> = {},
): Input<typeof ClaimCompleteDtoSchema> {
  return { humanId: IDS.xavier, groupId: IDS.group, conversationId: IDS.conversation, ...overrides }
}

export function verificationBegin(
  overrides: Overrides<typeof VerificationBeginDtoSchema> = {},
): Input<typeof VerificationBeginDtoSchema> {
  return { humanPassId: IDS.review, status: 'verifying', ...overrides }
}

export function verificationSession(
  overrides: Overrides<typeof VerificationSessionDtoSchema> = {},
): Input<typeof VerificationSessionDtoSchema> {
  return {
    sessionId: 'sess_123',
    status: 'verifying',
    providerUrl: null,
    expiresAt: LATER,
    ...overrides,
  }
}

/** `GET /api/claim/verification/:sessionId` exactly as the server tier answers it. */
export function verificationResult(
  overrides: Overrides<typeof VerificationResultDtoSchema> = {},
): Input<typeof VerificationResultDtoSchema> {
  return { sessionId: 'sess_123', status: 'verified', failureKind: null, ...overrides }
}

export function identityReview(
  overrides: Overrides<typeof IdentityReviewDtoSchema> = {},
): Input<typeof IdentityReviewDtoSchema> {
  return {
    id: IDS.review,
    humanId: IDS.xavier,
    kind: 'help',
    status: 'open',
    createdAt: AT,
    ...overrides,
  }
}

export function mediaObjectRow(
  overrides: Overrides<typeof MediaObjectRowSchema> = {},
): Input<typeof MediaObjectRowSchema> {
  return {
    id: IDS.media,
    bucket: 'avatars',
    storage_key: `${IDS.xavier}/abc.jpg`,
    content_type: 'image/jpeg',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export function groupDto(
  overrides: Overrides<typeof GroupDtoSchema> = {},
): Input<typeof GroupDtoSchema> {
  return {
    id: IDS.group,
    name: 'Weekend Crew',
    avatarUrl: null,
    kind: 'persistent',
    status: 'active',
    createdByHumanId: IDS.xavier,
    conversationId: IDS.conversation,
    memberCount: 3,
    myRole: 'owner',
    activeRoom: null,
    createdAt: AT,
    lastActivityAt: AT,
    ...overrides,
  }
}

export function groupMember(
  overrides: Overrides<typeof GroupMemberDtoSchema> = {},
): Input<typeof GroupMemberDtoSchema> {
  return {
    humanId: IDS.maya,
    displayName: 'Maya',
    handle: 'maya',
    avatarUrl: null,
    role: 'member',
    status: 'active',
    joinedAt: AT,
    isFriend: true,
    ...overrides,
  }
}

export function groupDetail(
  overrides: Overrides<typeof GroupDetailDtoSchema> = {},
): Input<typeof GroupDetailDtoSchema> {
  return { ...groupDto(), members: [groupMember()], ...overrides }
}

export function groupInvitePreview(
  overrides: Overrides<typeof GroupInvitePreviewDtoSchema> = {},
): Input<typeof GroupInvitePreviewDtoSchema> {
  return {
    groupName: 'Weekend Crew',
    memberCount: 3,
    sampleMembers: [{ displayName: 'Xavier', avatarUrl: AVATAR }],
    alreadyMember: false,
    expired: false,
    ...overrides,
  }
}

export function groupInviteCreate(
  overrides: Overrides<typeof GroupInviteCreateDtoSchema> = {},
): Input<typeof GroupInviteCreateDtoSchema> {
  return { token: 'tok_group_1', url: `${ORIGIN}/g/tok_group_1`, expiresAt: LATER, ...overrides }
}

export function groupJoin(
  overrides: Overrides<typeof GroupJoinDtoSchema> = {},
): Input<typeof GroupJoinDtoSchema> {
  return {
    groupId: IDS.group,
    conversationId: IDS.conversation,
    alreadyMember: false,
    isSecondGroup: false,
    ...overrides,
  }
}

export function groupInviteRow(
  overrides: Overrides<typeof GroupInviteRowSchema> = {},
): Input<typeof GroupInviteRowSchema> {
  return {
    id: IDS.invite,
    group_id: IDS.group,
    created_by: IDS.xavier,
    expires_at: LATER,
    max_uses: null,
    use_count: 2,
    status: 'active',
    created_at: AT,
    revoked_at: null,
    ...overrides,
  }
}

export function groupInviteRevoke(
  overrides: Overrides<typeof GroupInviteRevokeDtoSchema> = {},
): Input<typeof GroupInviteRevokeDtoSchema> {
  return { id: IDS.invite, groupId: IDS.group, status: 'revoked', revokedAt: AT, ...overrides }
}

export function groupLeave(
  overrides: Overrides<typeof GroupLeaveDtoSchema> = {},
): Input<typeof GroupLeaveDtoSchema> {
  return { groupId: IDS.group, left: true, newOwnerHumanId: null, archived: false, ...overrides }
}

export function groupMemberRemove(
  overrides: Overrides<typeof GroupMemberRemoveDtoSchema> = {},
): Input<typeof GroupMemberRemoveDtoSchema> {
  return { groupId: IDS.group, humanId: IDS.maya, status: 'removed', ...overrides }
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export function conversationSummary(
  overrides: Overrides<typeof ConversationSummaryDtoSchema> = {},
): Input<typeof ConversationSummaryDtoSchema> {
  return {
    id: IDS.conversation,
    type: 'group',
    groupId: IDS.group,
    title: 'Weekend Crew',
    avatarUrls: [AVATAR],
    lastMessage: {
      id: IDS.message,
      senderHumanId: IDS.maya,
      senderDisplayName: 'Maya',
      type: 'text',
      text: 'Anyone around tonight?',
      createdAt: AT,
    },
    unreadCount: 1,
    activeRoom: null,
    lastMessageAt: AT,
    ...overrides,
  }
}

export function conversationDetail(
  overrides: Overrides<typeof ConversationDetailDtoSchema> = {},
): Input<typeof ConversationDetailDtoSchema> {
  return {
    ...conversationSummary(),
    members: [
      {
        humanId: IDS.xavier,
        displayName: 'Xavier',
        handle: 'xavier',
        avatarUrl: AVATAR,
        joinedAt: AT,
        lastReadMessageId: IDS.message,
      },
      {
        humanId: IDS.maya,
        displayName: 'Maya',
        handle: 'maya',
        avatarUrl: null,
        joinedAt: AT,
        lastReadMessageId: null,
      },
    ],
    ...overrides,
  }
}

export function conversationsPage(
  overrides: Overrides<typeof ConversationsPageDtoSchema> = {},
): Input<typeof ConversationsPageDtoSchema> {
  return { conversations: [conversationSummary()], nextCursor: AT, ...overrides }
}

export function messageDto(
  overrides: Overrides<typeof MessageDtoSchema> = {},
): Input<typeof MessageDtoSchema> {
  return {
    id: IDS.message,
    conversationId: IDS.conversation,
    senderHumanId: IDS.maya,
    type: 'text',
    text: 'Anyone around tonight?',
    payload: {},
    replyToMessageId: null,
    createdAt: AT,
    editedAt: null,
    deletedAt: null,
    clientId: IDS.client,
    reactions: [{ reaction: '❤️', count: 2, reactedByMe: true }],
    ...overrides,
  }
}

export function messagesPage(
  overrides: Overrides<typeof MessagesPageDtoSchema> = {},
): Input<typeof MessagesPageDtoSchema> {
  return { messages: [messageDto()], nextCursor: null, ...overrides }
}

export function conversationPrefs(
  overrides: Overrides<typeof ConversationPrefsDtoSchema> = {},
): Input<typeof ConversationPrefsDtoSchema> {
  return {
    conversationId: IDS.conversation,
    muteState: 'muted',
    notificationLevel: 'mentions',
    ...overrides,
  }
}

export function readReceipt(
  overrides: Overrides<typeof ReadReceiptDtoSchema> = {},
): Input<typeof ReadReceiptDtoSchema> {
  return { humanId: IDS.maya, lastReadMessageId: IDS.message, lastReadAt: AT, ...overrides }
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

export function roomParticipant(
  overrides: Overrides<typeof RoomParticipantDtoSchema> = {},
): Input<typeof RoomParticipantDtoSchema> {
  return {
    id: IDS.participant,
    humanId: IDS.xavier,
    guestSessionId: null,
    displayName: 'Xavier',
    avatarUrl: AVATAR,
    isGuest: false,
    role: 'initiator',
    mediaState: 'camera',
    status: 'active',
    audienceConsentLevel: 'group',
    joinedAt: AT,
    relationToViewer: 'self',
    ...overrides,
  }
}

export function roomDto(
  overrides: Overrides<typeof RoomDtoSchema> = {},
): Input<typeof RoomDtoSchema> {
  return {
    id: IDS.room,
    contextType: 'group',
    contextId: IDS.group,
    initiatedByHumanId: IDS.xavier,
    visibility: 'group',
    joinPolicy: 'group',
    status: 'active',
    areaPrecision: 'none',
    areaId: null,
    placeId: null,
    createdAt: AT,
    startedAt: AT,
    endedAt: null,
    pendingVisibility: null,
    participants: [roomParticipant()],
    myParticipant: roomParticipant(),
    contextTitle: 'Weekend Crew',
    guestsDisabled: false,
    ...overrides,
  }
}

export function roomStart(
  overrides: Overrides<typeof RoomStartDtoSchema> = {},
): Input<typeof RoomStartDtoSchema> {
  return { room: roomDto(), created: true, ...overrides }
}

export function roomVisibilityChange(
  overrides: Overrides<typeof RoomVisibilityChangeDtoSchema> = {},
): Input<typeof RoomVisibilityChangeDtoSchema> {
  return {
    applied: false,
    visibility: 'group',
    pendingVisibility: 'friends',
    pendingParticipantIds: [IDS.participant],
    ...overrides,
  }
}

export function roomLeave(
  overrides: Overrides<typeof RoomLeaveDtoSchema> = {},
): Input<typeof RoomLeaveDtoSchema> {
  return { transferredTo: IDS.maya, ...overrides }
}

export function roomInvitePreview(
  overrides: Overrides<typeof RoomInvitePreviewDtoSchema> = {},
): Input<typeof RoomInvitePreviewDtoSchema> {
  return {
    roomId: IDS.room,
    contextTitle: 'Weekend Crew',
    visibility: 'group',
    joinPolicy: 'anyone_with_link',
    participants: [{ displayName: 'Xavier', avatarUrl: AVATAR, isGuest: false }],
    invitedByDisplayName: 'Xavier',
    guestsAllowed: true,
    ended: false,
    ...overrides,
  }
}

export function roomInviteCreate(
  overrides: Overrides<typeof RoomInviteCreateDtoSchema> = {},
): Input<typeof RoomInviteCreateDtoSchema> {
  return { token: 'tok_room_1', url: `${ORIGIN}/live/tok_room_1`, expiresAt: LATER, ...overrides }
}

export function guestSession(
  overrides: Overrides<typeof GuestSessionDtoSchema> = {},
): Input<typeof GuestSessionDtoSchema> {
  return {
    guestSessionId: IDS.guest,
    roomId: IDS.room,
    displayName: 'Sam',
    expiresAt: LATER,
    ...overrides,
  }
}

export function guestSessions(
  overrides: Overrides<typeof GuestSessionsDtoSchema> = {},
): Input<typeof GuestSessionsDtoSchema> {
  return { sessions: [guestSession()], roomsJoined: 1, humansMet: 2, ...overrides }
}

export function roomToken(
  overrides: Overrides<typeof RoomTokenDtoSchema> = {},
): Input<typeof RoomTokenDtoSchema> {
  return {
    token: 'lk.jwt',
    url: 'wss://livekit.earth.social',
    identity: `h:${IDS.xavier}`,
    expiresAt: LATER,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Posts, feed, live
// ---------------------------------------------------------------------------

export function postDto(
  overrides: Overrides<typeof PostDtoSchema> = {},
): Input<typeof PostDtoSchema> {
  return {
    id: IDS.post,
    authorHumanId: IDS.xavier,
    type: 'text',
    text: 'Coffee at Dolores?',
    audience: 'friends',
    areaId: null,
    placeId: null,
    replyPolicy: 'everyone_eligible',
    resharePolicy: 'allowed_within_audience',
    parentPostId: null,
    rootPostId: null,
    createdAt: AT,
    editedAt: null,
    deletedAt: null,
    ...overrides,
  }
}

export function postView(
  overrides: Overrides<typeof PostViewDtoSchema> = {},
): Input<typeof PostViewDtoSchema> {
  return {
    post: postDto(),
    author: identity(),
    reactionCount: 4,
    replyCount: 1,
    myReaction: null,
    place: null,
    media: [],
    ...overrides,
  }
}

export function postDetail(
  overrides: Overrides<typeof PostDetailDtoSchema> = {},
): Input<typeof PostDetailDtoSchema> {
  return {
    ...postView(),
    replies: [
      postView({
        post: postDto({
          id: IDS.reply,
          parentPostId: IDS.post,
          rootPostId: IDS.post,
          text: 'Yes!',
        }),
      }),
    ],
    ...overrides,
  }
}

export function liveCard(
  overrides: Overrides<typeof LiveCardDtoSchema> = {},
): Input<typeof LiveCardDtoSchema> {
  return {
    kind: 'live',
    id: IDS.room,
    roomId: IDS.room,
    title: 'Xavier is live',
    participantNames: ['Xavier'],
    participantAvatars: [AVATAR],
    participantCount: 1,
    visibility: 'friends',
    contextTitle: null,
    startedAt: AT,
    areaName: null,
    ...overrides,
  }
}

export function feedPage(
  overrides: Overrides<typeof FeedPageDtoSchema> = {},
): Input<typeof FeedPageDtoSchema> {
  return {
    cards: [{ kind: 'post', id: IDS.post, ...postView() }, liveCard()],
    nextCursor: 'eyJ2IjoxfQ',
    snapshotAt: AT,
    scope: 'friends',
    areaName: null,
    ...overrides,
  }
}

export function liveList(
  overrides: Overrides<typeof LiveListDtoSchema> = {},
): Input<typeof LiveListDtoSchema> {
  return { cards: [liveCard()], scope: 'friends', areaName: null, ...overrides }
}

// ---------------------------------------------------------------------------
// Social, safety, search
// ---------------------------------------------------------------------------

export function profileDto(
  overrides: Overrides<typeof ProfileDtoSchema> = {},
): Input<typeof ProfileDtoSchema> {
  return {
    identity: identity({ humanId: IDS.maya, displayName: 'Maya', handle: 'maya' }),
    relationship: {
      isSelf: false,
      isFriend: true,
      friendRequest: 'none',
      isFollowing: false,
      isFollowedBy: true,
      isBlocked: false,
    },
    mutualFriendCount: 8,
    sharedGroupCount: 1,
    counts: { friends: 12, followers: 3, following: 5, posts: 7 },
    canMessage: true,
    ...overrides,
  }
}

export function relationshipChange(
  overrides: Overrides<typeof RelationshipChangeDtoSchema> = {},
): Input<typeof RelationshipChangeDtoSchema> {
  return {
    humanId: IDS.maya,
    isFriend: false,
    friendRequest: 'sent',
    isFollowing: false,
    updatedAt: AT,
    ...overrides,
  }
}

export function blockChange(
  overrides: Overrides<typeof BlockChangeDtoSchema> = {},
): Input<typeof BlockChangeDtoSchema> {
  return { ...relationshipChange({ friendRequest: 'none' }), isBlocked: true, ...overrides }
}

export function blocksList(
  overrides: Overrides<typeof BlocksListDtoSchema> = {},
): Input<typeof BlocksListDtoSchema> {
  return {
    blocks: [{ blockerHumanId: IDS.xavier, blockedHumanId: IDS.kavon, createdAt: AT }],
    ...overrides,
  }
}

export function reportDto(
  overrides: Overrides<typeof ReportDtoSchema> = {},
): Input<typeof ReportDtoSchema> {
  return { id: IDS.report, status: 'open', createdAt: AT, ...overrides }
}

export function searchResults(
  overrides: Overrides<typeof SearchResultsDtoSchema> = {},
): Input<typeof SearchResultsDtoSchema> {
  return {
    people: [
      {
        humanId: IDS.maya,
        displayName: 'Maya',
        handle: 'maya',
        avatarUrl: null,
        mutualFriendCount: 8,
        cityName: 'San Francisco',
        isFriend: true,
        isFollowing: false,
      },
    ],
    groups: [
      { groupId: IDS.group, name: 'Weekend Crew', avatarUrl: null, memberCount: 3, isMember: true },
    ],
    places: [
      {
        placeId: IDS.place,
        name: 'Dolores Park',
        areaName: 'Mission',
        lat: 37.7596,
        lng: -122.4269,
        category: 'park',
      },
    ],
    posts: [postView()],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export function notificationDto(
  overrides: Overrides<typeof NotificationDtoSchema> = {},
): Input<typeof NotificationDtoSchema> {
  return {
    id: IDS.notification,
    type: 'friend_live',
    priority: 'high',
    title: 'Xavier is live',
    body: 'Tap to watch',
    actorHumanId: IDS.xavier,
    objectType: 'room',
    objectId: IDS.room,
    payload: { roomId: IDS.room },
    readAt: null,
    createdAt: AT,
    ...overrides,
  }
}

export function notificationsPage(
  overrides: Overrides<typeof NotificationsPageDtoSchema> = {},
): Input<typeof NotificationsPageDtoSchema> {
  return { notifications: [notificationDto()], nextCursor: null, unreadCount: 3, ...overrides }
}

// ---------------------------------------------------------------------------
// Areas, places, location, map
// ---------------------------------------------------------------------------

export function areaDto(
  overrides: Overrides<typeof AreaDtoSchema> = {},
): Input<typeof AreaDtoSchema> {
  return {
    id: IDS.area,
    type: 'neighborhood',
    name: 'Mission',
    parentAreaId: IDS.city,
    centroid: { lat: 37.76, lng: -122.42 },
    ...overrides,
  }
}

export function cityDto(
  overrides: Overrides<typeof AreaDtoSchema> = {},
): Input<typeof AreaDtoSchema> {
  return areaDto({
    id: IDS.city,
    type: 'city',
    name: 'San Francisco',
    parentAreaId: null,
    centroid: { lat: 37.77, lng: -122.42 },
    ...overrides,
  })
}

export function areaResolution(
  overrides: Overrides<typeof AreaResolutionDtoSchema> = {},
): Input<typeof AreaResolutionDtoSchema> {
  return { neighborhood: areaDto(), city: cityDto(), ...overrides }
}

export function placeDto(
  overrides: Overrides<typeof PlaceDtoSchema> = {},
): Input<typeof PlaceDtoSchema> {
  return {
    id: IDS.place,
    name: 'Dolores Park',
    areaId: IDS.area,
    areaName: 'Mission',
    lat: 37.7596,
    lng: -122.4269,
    category: 'park',
    visibility: 'public',
    ...overrides,
  }
}

export function locationShare(
  overrides: Overrides<typeof LocationShareDtoSchema> = {},
): Input<typeof LocationShareDtoSchema> {
  return {
    id: IDS.share,
    humanId: IDS.xavier,
    audienceType: 'friend',
    audienceId: IDS.maya,
    precision: 'approximate',
    expiresAt: LATER,
    createdAt: AT,
    revokedAt: null,
    ...overrides,
  }
}

export function mapFriend(
  overrides: Overrides<typeof MapFriendDtoSchema> = {},
): Input<typeof MapFriendDtoSchema> {
  return {
    humanId: IDS.maya,
    displayName: 'Maya',
    avatarUrl: null,
    lat: 37.76,
    lng: -122.42,
    precision: 'approximate',
    expiresAt: LATER,
    ...overrides,
  }
}

export function mapObjects(
  overrides: Overrides<typeof MapObjectsDtoSchema> = {},
): Input<typeof MapObjectsDtoSchema> {
  return {
    lives: [
      {
        roomId: IDS.room,
        title: 'Xavier is live',
        lat: 37.76,
        lng: -122.42,
        precision: 'neighborhood',
        participantCount: 2,
      },
    ],
    places: [placeDto()],
    friends: [mapFriend()],
    moments: [{ postId: IDS.post, lat: 37.7596, lng: -122.4269, authorDisplayName: 'Xavier' }],
    ...overrides,
  }
}
