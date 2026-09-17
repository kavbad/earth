import { describe, expect, it } from 'vitest'
import type { z } from 'zod'

import {
  AreaDtoSchema,
  BlockDtoSchema,
  BoundingBoxSchema,
  ClaimCompleteDtoSchema,
  ClaimIdentityInputSchema,
  ClaimStartInputSchema,
  ClaimStateDtoSchema,
  ConversationCreateInputSchema,
  ConversationDetailDtoSchema,
  ConversationsListDtoSchema,
  ConversationSummaryDtoSchema,
  FeedCardDtoSchema,
  FeedPageDtoSchema,
  FlagsDtoSchema,
  GroupDetailDtoSchema,
  GroupDtoSchema,
  GroupInviteCreateDtoSchema,
  GroupInvitePreviewDtoSchema,
  GroupJoinDtoSchema,
  GroupMemberDtoSchema,
  GuestSessionCreateInputSchema,
  GuestSessionDtoSchema,
  HumanContextDtoSchema,
  HumanContextSetInputSchema,
  IsoDateTimeSchema,
  isFlagEnabled,
  LiveCardDtoSchema,
  LiveListDtoSchema,
  LocationShareDtoSchema,
  LocationShareInputSchema,
  MapObjectsDtoSchema,
  MeDtoSchema,
  MediaGrantDtoSchema,
  MessageDtoSchema,
  MessageSendInputSchema,
  MessagesPageDtoSchema,
  NotificationDtoSchema,
  NotificationsPageDtoSchema,
  PlaceDtoSchema,
  PostCreateInputSchema,
  PostDetailDtoSchema,
  PostDtoSchema,
  PostMediaDtoSchema,
  PostViewDtoSchema,
  PresenceCardDtoSchema,
  ProfileDtoSchema,
  PublicIdentityDtoSchema,
  RelationshipChangeDtoSchema,
  ReportInputSchema,
  RoomDtoSchema,
  RoomInviteCreateDtoSchema,
  RoomInvitePreviewDtoSchema,
  RoomJoinInputSchema,
  RoomLeaveDtoSchema,
  RoomParticipantDtoSchema,
  RoomSetVisibilityInputSchema,
  RoomStartDtoSchema,
  RoomStartInputSchema,
  RoomTokenDtoSchema,
  RoomVisibilityChangeDtoSchema,
  SearchResultsDtoSchema,
  VerificationSessionDtoSchema,
  activeParticipantCount,
} from './index'

// Fixture ids (valid v4 uuids)
const XAVIER = '11111111-1111-4111-8111-111111111111'
const MAYA = '22222222-2222-4222-8222-222222222222'
const KAVON = '33333333-3333-4333-8333-333333333333'
const GROUP = '44444444-4444-4444-8444-444444444444'
const CONVERSATION = '55555555-5555-4555-8555-555555555555'
const MESSAGE = '66666666-6666-4666-8666-666666666666'
const ROOM = '77777777-7777-4777-8777-777777777777'
const POST = '88888888-8888-4888-8888-888888888888'
const GUEST = '99999999-9999-4999-8999-999999999999'
const AREA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CITY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PLACE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const NOTIFICATION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const PARTICIPANT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const CLIENT = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const AT = '2026-09-03T06:00:00.123456+00:00'
const AVATAR = 'https://cdn.earth.social/avatars/xavier.jpg'

const xavier = {
  humanId: XAVIER,
  displayName: 'Xavier',
  handle: 'xavier',
  avatarUrl: AVATAR,
  bio: null,
  cityName: 'San Francisco',
  profileVisibility: 'public',
}

const post = {
  id: POST,
  authorHumanId: XAVIER,
  type: 'text',
  text: 'Cooking dinner',
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
}

const place = {
  id: PLACE,
  name: 'Dolores Park',
  areaId: AREA,
  areaName: 'Mission',
  lat: 37.7596,
  lng: -122.4269,
  category: 'park',
  visibility: 'public',
}

const media = {
  id: CLIENT,
  postId: POST,
  mediaType: 'image',
  url: 'https://cdn.earth.social/media/1.jpg',
  width: 1080,
  height: 1350,
  durationMs: null,
  provenance: 'earth_capture',
}

const postView = {
  post,
  author: xavier,
  reactionCount: 3,
  replyCount: 1,
  myReaction: null,
  place,
  media: [media],
}

const participant = {
  id: PARTICIPANT,
  humanId: XAVIER,
  guestSessionId: null,
  displayName: 'Xavier',
  avatarUrl: AVATAR,
  isGuest: false,
  role: 'initiator',
  mediaState: 'camera',
  status: 'active',
  audienceConsentLevel: 'friends',
  joinedAt: AT,
  relationToViewer: 'friend',
}

const guestParticipant = {
  id: CLIENT,
  humanId: null,
  guestSessionId: GUEST,
  displayName: 'Sam',
  avatarUrl: null,
  isGuest: true,
  role: 'participant',
  mediaState: 'audio',
  status: 'active',
  audienceConsentLevel: 'invited',
  joinedAt: AT,
  relationToViewer: null,
}

const room = {
  id: ROOM,
  contextType: 'group',
  contextId: GROUP,
  initiatedByHumanId: XAVIER,
  visibility: 'group',
  joinPolicy: 'group',
  status: 'active',
  areaPrecision: 'none',
  areaId: null,
  placeId: null,
  createdAt: AT,
  startedAt: AT,
  endedAt: null,
  pendingVisibility: 'friends',
  participants: [participant, guestParticipant],
  myParticipant: participant,
  contextTitle: 'Weekend Crew',
  guestsDisabled: false,
}

const liveCard = {
  kind: 'live',
  id: ROOM,
  roomId: ROOM,
  title: 'Xavier + Kavon are live',
  participantNames: ['Xavier', 'Kavon'],
  participantAvatars: [AVATAR, null],
  participantCount: 2,
  visibility: 'friends',
  contextTitle: null,
  startedAt: AT,
  areaName: null,
}

const presenceCard = {
  kind: 'presence',
  id: 'presence',
  items: [
    {
      type: 'group_active',
      label: 'Weekend Crew · 3 active',
      humanIds: [XAVIER, MAYA, KAVON],
      roomId: null,
      conversationId: CONVERSATION,
      groupId: GROUP,
      avatarUrls: [AVATAR],
    },
  ],
}

const message = {
  id: MESSAGE,
  conversationId: CONVERSATION,
  senderHumanId: MAYA,
  type: 'text',
  text: 'On my way',
  payload: {},
  replyToMessageId: null,
  createdAt: AT,
  editedAt: null,
  deletedAt: null,
  clientId: CLIENT,
  reactions: [{ reaction: '❤️', count: 2, reactedByMe: true }],
}

const conversation = {
  id: CONVERSATION,
  type: 'group',
  groupId: GROUP,
  title: 'Weekend Crew',
  avatarUrls: [AVATAR],
  lastMessage: {
    id: MESSAGE,
    senderHumanId: MAYA,
    senderDisplayName: 'Maya',
    type: 'text',
    text: 'On my way',
    createdAt: AT,
  },
  unreadCount: 2,
  activeRoom: { roomId: ROOM, participantCount: 3 },
  lastMessageAt: AT,
}

const group = {
  id: GROUP,
  name: 'Weekend Crew',
  avatarUrl: null,
  kind: 'persistent',
  status: 'active',
  createdByHumanId: XAVIER,
  conversationId: CONVERSATION,
  memberCount: 7,
  myRole: 'owner',
  activeRoom: null,
  createdAt: AT,
  lastActivityAt: AT,
}

const member = {
  humanId: MAYA,
  displayName: 'Maya',
  handle: 'maya',
  avatarUrl: null,
  role: 'member',
  status: 'active',
  joinedAt: AT,
  isFriend: false,
}

const notification = {
  id: NOTIFICATION,
  type: 'friend_live',
  priority: 'high',
  title: 'Xavier is live',
  body: 'Cooking dinner',
  actorHumanId: XAVIER,
  objectType: 'room',
  objectId: ROOM,
  payload: { roomId: ROOM },
  readAt: null,
  createdAt: AT,
}

interface Case {
  name: string
  schema: z.ZodType
  sample: unknown
  /** Same shape with one wrong-typed field. */
  corrupt: unknown
}

const mutate = (sample: object, patch: Record<string, unknown>): unknown => ({
  ...sample,
  ...patch,
})

const cases: Case[] = [
  {
    name: 'FlagsDto',
    schema: FlagsDtoSchema,
    sample: {
      GROUP_ANCHORED_CLAIM_REQUIRED: { enabled: true, payload: null, updatedAt: AT },
      MAFIA_ACTIVITY_ENABLED: { enabled: false, payload: { minPlayers: 5 }, updatedAt: AT },
    },
    corrupt: { GROUP_ANCHORED_CLAIM_REQUIRED: { enabled: 'yes', payload: null, updatedAt: AT } },
  },
  {
    name: 'ClaimStateDto',
    schema: ClaimStateDtoSchema,
    sample: {
      status: 'verifying',
      intent: 'join_group',
      groupLabel: null,
      inviteToken: 'tok_abc',
      identity: { displayName: 'Maya', handle: 'maya', avatarUrl: null },
      verification: { status: 'verifying', sessionId: 'sess_1' },
      humanId: MAYA,
    },
    corrupt: {
      status: 'verifying',
      intent: 'join_group',
      groupLabel: null,
      verification: { status: 'done' },
      humanId: MAYA,
    },
  },
  {
    name: 'ClaimCompleteDto',
    schema: ClaimCompleteDtoSchema,
    sample: { humanId: MAYA, groupId: GROUP, conversationId: CONVERSATION },
    corrupt: { humanId: MAYA, groupId: 'weekend-crew', conversationId: CONVERSATION },
  },
  {
    name: 'VerificationSessionDto',
    schema: VerificationSessionDtoSchema,
    sample: { sessionId: 'sess_1', status: 'verifying', providerUrl: null, expiresAt: AT },
    corrupt: { sessionId: 'sess_1', status: 'verifying', providerUrl: 'nope', expiresAt: AT },
  },
  {
    name: 'PublicIdentityDto',
    schema: PublicIdentityDtoSchema,
    sample: xavier,
    corrupt: mutate(xavier, { handle: 'Xavier!' }),
  },
  {
    name: 'ProfileDto',
    schema: ProfileDtoSchema,
    sample: {
      identity: xavier,
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
      counts: { friends: 40, followers: 12, following: 9, posts: 3 },
      canMessage: true,
    },
    corrupt: {
      identity: xavier,
      relationship: {
        isSelf: false,
        isFriend: true,
        friendRequest: 'none',
        isFollowing: false,
        isFollowedBy: true,
        isBlocked: false,
      },
      mutualFriendCount: -1,
      sharedGroupCount: 1,
      counts: { friends: 40, followers: 12, following: 9, posts: 3 },
      canMessage: true,
    },
  },
  {
    name: 'GroupDto',
    schema: GroupDtoSchema,
    sample: group,
    corrupt: mutate(group, { memberCount: '7' }),
  },
  {
    name: 'GroupMemberDto',
    schema: GroupMemberDtoSchema,
    sample: member,
    corrupt: mutate(member, { role: 'admin' }),
  },
  {
    name: 'GroupDetailDto',
    schema: GroupDetailDtoSchema,
    sample: { ...group, members: [member] },
    corrupt: { ...group, members: [mutate(member, { isFriend: 'no' })] },
  },
  {
    name: 'GroupInvitePreviewDto',
    schema: GroupInvitePreviewDtoSchema,
    sample: {
      groupName: 'Weekend Crew',
      memberCount: 7,
      sampleMembers: [
        { displayName: 'Maya', avatarUrl: null },
        { displayName: 'Xavier', avatarUrl: AVATAR },
      ],
      alreadyMember: false,
      expired: false,
    },
    corrupt: {
      groupName: null,
      memberCount: 7,
      sampleMembers: [{ displayName: 'Maya' }],
      alreadyMember: false,
      expired: false,
    },
  },
  {
    name: 'GroupInviteCreateDto',
    schema: GroupInviteCreateDtoSchema,
    sample: { token: 'tok_abc', url: 'https://earth.social/g/tok_abc', expiresAt: null },
    corrupt: { token: 'tok_abc', url: '/g/tok_abc', expiresAt: null },
  },
  {
    name: 'GroupJoinDto',
    schema: GroupJoinDtoSchema,
    sample: {
      groupId: GROUP,
      conversationId: CONVERSATION,
      alreadyMember: false,
      isSecondGroup: true,
    },
    corrupt: { groupId: GROUP, conversationId: CONVERSATION, alreadyMember: false },
  },
  {
    name: 'ConversationDetailDto',
    schema: ConversationDetailDtoSchema,
    sample: {
      ...conversation,
      members: [
        {
          humanId: MAYA,
          displayName: 'Maya',
          handle: 'maya',
          avatarUrl: null,
          joinedAt: AT,
          lastReadMessageId: MESSAGE,
        },
        {
          humanId: XAVIER,
          displayName: 'Xavier',
          handle: 'xavier',
          avatarUrl: AVATAR,
          joinedAt: AT,
          lastReadMessageId: null,
        },
      ],
    },
    corrupt: {
      ...conversation,
      members: [{ humanId: MAYA, displayName: 'Maya', handle: 'maya', avatarUrl: null }],
    },
  },
  {
    name: 'RoomLeaveDto',
    schema: RoomLeaveDtoSchema,
    sample: { transferredTo: MAYA },
    corrupt: { transferredTo: 'maya' },
  },
  {
    name: 'MeDto',
    schema: MeDtoSchema,
    sample: {
      roleKind: 'human',
      humanId: XAVIER,
      identity: xavier,
      humanStatus: 'active',
      humanPassStatus: 'verified',
      context: {
        currentAreaId: AREA,
        currentAreaName: 'Mission',
        currentCityId: CITY,
        currentCityName: 'San Francisco',
        homeCityId: CITY,
      },
      flags: { PUBLIC_WORLD_ENABLED: { enabled: true, payload: null, updatedAt: AT } },
    },
    corrupt: {
      roleKind: 'member',
      humanId: XAVIER,
      identity: xavier,
      humanStatus: 'active',
      humanPassStatus: 'verified',
      context: null,
      flags: {},
    },
  },
  {
    name: 'ConversationSummaryDto',
    schema: ConversationSummaryDtoSchema,
    sample: conversation,
    corrupt: mutate(conversation, { unreadCount: 1.5 }),
  },
  {
    name: 'ConversationsListDto',
    schema: ConversationsListDtoSchema,
    sample: {
      conversations: [conversation, mutate(conversation, { activeRoom: null, lastMessage: null })],
    },
    corrupt: { conversations: conversation },
  },
  {
    name: 'MessageDto',
    schema: MessageDtoSchema,
    sample: message,
    corrupt: mutate(message, { createdAt: 1_700_000_000 }),
  },
  {
    name: 'MessagesPageDto',
    schema: MessagesPageDtoSchema,
    sample: { messages: [message], nextCursor: 'eyJ2IjoxfQ' },
    corrupt: { messages: [message], nextCursor: undefined },
  },
  {
    name: 'RoomParticipantDto',
    schema: RoomParticipantDtoSchema,
    sample: participant,
    corrupt: mutate(participant, { mediaState: 'video' }),
  },
  {
    name: 'RoomDto',
    schema: RoomDtoSchema,
    sample: room,
    corrupt: mutate(room, { guestsDisabled: null }),
  },
  {
    name: 'RoomStartDto',
    schema: RoomStartDtoSchema,
    sample: { room, created: true },
    corrupt: { room, created: 'true' },
  },
  {
    name: 'RoomVisibilityChangeDto',
    schema: RoomVisibilityChangeDtoSchema,
    sample: {
      applied: false,
      visibility: 'group',
      pendingVisibility: 'friends',
      pendingParticipantIds: [PARTICIPANT],
    },
    corrupt: {
      applied: false,
      visibility: 'group',
      pendingVisibility: 'friends',
      pendingParticipantIds: [1],
    },
  },
  {
    name: 'RoomInvitePreviewDto',
    schema: RoomInvitePreviewDtoSchema,
    sample: {
      roomId: ROOM,
      contextTitle: 'Weekend Crew',
      visibility: 'group',
      joinPolicy: 'anyone_with_link',
      participants: [{ displayName: 'Xavier', avatarUrl: AVATAR, isGuest: false }],
      invitedByDisplayName: 'Xavier',
      guestsAllowed: true,
      ended: false,
    },
    corrupt: {
      roomId: ROOM,
      contextTitle: 'Weekend Crew',
      visibility: 'group',
      joinPolicy: 'anyone_with_link',
      participants: [{ displayName: 'Xavier', avatarUrl: AVATAR, isGuest: 'guest' }],
      invitedByDisplayName: 'Xavier',
      guestsAllowed: true,
      ended: false,
    },
  },
  {
    name: 'RoomInviteCreateDto',
    schema: RoomInviteCreateDtoSchema,
    sample: { token: 'tok_room', url: 'https://earth.social/live/tok_room', expiresAt: AT },
    corrupt: { token: 'tok_room', url: 'https://earth.social/live/tok_room', expiresAt: null },
  },
  {
    name: 'GuestSessionDto',
    schema: GuestSessionDtoSchema,
    sample: { guestSessionId: GUEST, roomId: ROOM, displayName: 'Sam', expiresAt: AT },
    corrupt: { guestSessionId: GUEST, roomId: ROOM, displayName: '', expiresAt: AT },
  },
  {
    name: 'MediaGrantDto',
    schema: MediaGrantDtoSchema,
    sample: {
      livekitRoom: ROOM,
      identity: `g:${GUEST}`,
      name: 'Sam',
      role: 'participant',
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      ttlSeconds: 7200,
    },
    corrupt: {
      livekitRoom: ROOM,
      identity: GUEST,
      name: 'Sam',
      role: 'participant',
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      ttlSeconds: 7200,
    },
  },
  {
    name: 'RoomTokenDto',
    schema: RoomTokenDtoSchema,
    sample: {
      token: 'eyJhbGciOi...',
      url: 'wss://livekit.earth.social',
      identity: `h:${XAVIER}`,
      expiresAt: AT,
    },
    corrupt: {
      token: 'eyJhbGciOi...',
      url: 'wss://livekit.earth.social',
      identity: `h:${XAVIER}`,
      expiresAt: '',
    },
  },
  {
    name: 'PostDto',
    schema: PostDtoSchema,
    sample: post,
    corrupt: mutate(post, { audience: 'public' }),
  },
  {
    name: 'PostMediaDto',
    schema: PostMediaDtoSchema,
    sample: media,
    corrupt: mutate(media, { width: '1080' }),
  },
  {
    name: 'PostViewDto',
    schema: PostViewDtoSchema,
    sample: postView,
    corrupt: mutate(postView, { author: null }),
  },
  {
    name: 'PostDetailDto',
    schema: PostDetailDtoSchema,
    sample: {
      ...postView,
      replies: [{ ...postView, post: mutate(post, { parentPostId: POST, rootPostId: POST }) }],
    },
    corrupt: {
      ...postView,
      replies: [{ ...postView, post: mutate(post, { parentPostId: POST, rootPostId: 7 }) }],
    },
  },
  {
    name: 'FeedCardDto (post)',
    schema: FeedCardDtoSchema,
    sample: { kind: 'post', id: POST, ...postView },
    corrupt: { kind: 'post', id: POST, ...postView, reactionCount: 'many' },
  },
  {
    name: 'FeedCardDto (live)',
    schema: FeedCardDtoSchema,
    sample: liveCard,
    corrupt: mutate(liveCard, { participantNames: 'Xavier' }),
  },
  {
    name: 'LiveCardDto',
    schema: LiveCardDtoSchema,
    sample: liveCard,
    corrupt: mutate(liveCard, { kind: 'post' }),
  },
  {
    name: 'PresenceCardDto',
    schema: PresenceCardDtoSchema,
    sample: presenceCard,
    corrupt: mutate(presenceCard, { items: [] }),
  },
  {
    name: 'FeedPageDto',
    schema: FeedPageDtoSchema,
    sample: {
      cards: [presenceCard, liveCard, { kind: 'post', id: POST, ...postView }],
      nextCursor: null,
      snapshotAt: AT,
      scope: 'friends',
      areaName: null,
    },
    corrupt: {
      cards: [liveCard],
      nextCursor: null,
      snapshotAt: AT,
      scope: 'everyone',
      areaName: null,
    },
  },
  {
    name: 'LiveListDto',
    schema: LiveListDtoSchema,
    sample: { cards: [liveCard], scope: 'city', areaName: 'San Francisco' },
    corrupt: { cards: [presenceCard], scope: 'city', areaName: 'San Francisco' },
  },
  {
    name: 'NotificationDto',
    schema: NotificationDtoSchema,
    sample: notification,
    corrupt: mutate(notification, { type: 'like' }),
  },
  {
    name: 'NotificationsPageDto',
    schema: NotificationsPageDtoSchema,
    sample: { notifications: [notification], nextCursor: null, unreadCount: 1 },
    corrupt: { notifications: [notification], nextCursor: null, unreadCount: null },
  },
  {
    name: 'SearchResultsDto',
    schema: SearchResultsDtoSchema,
    sample: {
      people: [
        {
          humanId: XAVIER,
          displayName: 'Xavier',
          handle: 'xavier',
          avatarUrl: AVATAR,
          mutualFriendCount: 8,
          cityName: 'San Francisco',
          isFriend: false,
          isFollowing: true,
        },
      ],
      groups: [
        { groupId: GROUP, name: 'Weekend Crew', avatarUrl: null, memberCount: 7, isMember: true },
      ],
      places: [
        {
          placeId: PLACE,
          name: 'Dolores Park',
          areaName: 'Mission',
          lat: 37.7596,
          lng: -122.4269,
          category: 'park',
        },
      ],
      posts: [postView],
    },
    corrupt: {
      people: [
        {
          humanId: XAVIER,
          displayName: 'Xavier',
          handle: 'xavier',
          avatarUrl: AVATAR,
          mutualFriendCount: 8,
          cityName: null,
          isFriend: false,
          isFollowing: 'yes',
        },
      ],
      groups: [],
      places: [],
      posts: [],
    },
  },
  {
    name: 'AreaDto',
    schema: AreaDtoSchema,
    sample: {
      id: AREA,
      type: 'neighborhood',
      name: 'Mission',
      parentAreaId: CITY,
      centroid: { lat: 37.76, lng: -122.42 },
    },
    corrupt: {
      id: AREA,
      type: 'neighborhood',
      name: 'Mission',
      parentAreaId: CITY,
      centroid: { lat: 137.76, lng: -122.42 },
    },
  },
  {
    name: 'PlaceDto',
    schema: PlaceDtoSchema,
    sample: place,
    corrupt: mutate(place, { lng: '-122.4269' }),
  },
  {
    name: 'LocationShareDto',
    schema: LocationShareDtoSchema,
    sample: {
      id: CLIENT,
      humanId: XAVIER,
      audienceType: 'group',
      audienceId: GROUP,
      precision: 'precise',
      expiresAt: AT,
      createdAt: AT,
      revokedAt: null,
    },
    corrupt: {
      id: CLIENT,
      humanId: XAVIER,
      audienceType: 'group',
      audienceId: GROUP,
      precision: 'exact',
      expiresAt: AT,
      createdAt: AT,
      revokedAt: null,
    },
  },
  {
    name: 'MapObjectsDto',
    schema: MapObjectsDtoSchema,
    sample: {
      lives: [
        {
          roomId: ROOM,
          title: 'Xavier is live',
          lat: 37.77,
          lng: -122.42,
          precision: 'neighborhood',
          participantCount: 2,
        },
      ],
      places: [place],
      friends: [
        {
          humanId: MAYA,
          displayName: 'Maya',
          avatarUrl: null,
          lat: 37.78,
          lng: -122.41,
          precision: 'approximate',
          expiresAt: AT,
        },
      ],
      moments: [{ postId: POST, lat: 37.75, lng: -122.43, authorDisplayName: 'Xavier' }],
    },
    corrupt: {
      lives: [
        {
          roomId: ROOM,
          title: 'Xavier is live',
          lat: 37.77,
          lng: -122.42,
          precision: 'exact',
          participantCount: 2,
        },
      ],
      places: [],
      friends: [],
      moments: [],
    },
  },
  {
    name: 'HumanContextDto',
    schema: HumanContextDtoSchema,
    sample: {
      currentAreaId: AREA,
      currentAreaName: 'Mission',
      currentCityId: CITY,
      currentCityName: 'San Francisco',
      homeCityId: CITY,
    },
    corrupt: {
      currentAreaId: AREA,
      currentAreaName: 'Mission',
      currentCityId: CITY,
      currentCityName: 'San Francisco',
      homeCityId: 'sf',
    },
  },
  {
    name: 'BlockDto',
    schema: BlockDtoSchema,
    sample: { blockerHumanId: XAVIER, blockedHumanId: KAVON, createdAt: AT },
    corrupt: { blockerHumanId: XAVIER, blockedHumanId: KAVON, createdAt: null },
  },
  {
    name: 'RelationshipChangeDto',
    schema: RelationshipChangeDtoSchema,
    sample: {
      humanId: MAYA,
      isFriend: false,
      friendRequest: 'sent',
      isFollowing: true,
      updatedAt: AT,
    },
    corrupt: {
      humanId: MAYA,
      isFriend: false,
      friendRequest: 'pending',
      isFollowing: true,
      updatedAt: AT,
    },
  },
  // Inputs
  {
    name: 'ClaimStartInput',
    schema: ClaimStartInputSchema,
    sample: { intent: 'start_group', groupLabel: 'Weekend Crew' },
    corrupt: { intent: 'join_group' },
  },
  {
    name: 'ClaimIdentityInput',
    schema: ClaimIdentityInputSchema,
    sample: { displayName: 'Maya', handle: 'maya', avatarMediaId: null },
    corrupt: { displayName: 'Maya', handle: 'Maya Chen' },
  },
  {
    name: 'MessageSendInput',
    schema: MessageSendInputSchema,
    sample: {
      conversationId: CONVERSATION,
      clientId: CLIENT,
      type: 'text',
      text: 'hi',
      replyToMessageId: null,
    },
    corrupt: {
      conversationId: CONVERSATION,
      clientId: CLIENT,
      type: 'text',
      text: null,
      replyToMessageId: null,
    },
  },
  {
    name: 'ConversationCreateInput',
    schema: ConversationCreateInputSchema,
    sample: { humanIds: [MAYA, KAVON] },
    corrupt: { humanIds: [] },
  },
  {
    name: 'RoomStartInput',
    schema: RoomStartInputSchema,
    sample: { contextType: 'standalone', contextId: null },
    corrupt: { contextType: 'group', contextId: null },
  },
  {
    name: 'RoomJoinInput',
    schema: RoomJoinInputSchema,
    sample: { roomId: ROOM, mediaState: 'camera', consentLevel: 'friends' },
    corrupt: { roomId: ROOM, mediaState: 'camera', consentLevel: 'everyone' },
  },
  {
    name: 'RoomSetVisibilityInput',
    schema: RoomSetVisibilityInputSchema,
    sample: { roomId: ROOM, visibility: 'extended', joinPolicy: 'friends_of_friends' },
    corrupt: { roomId: ROOM, visibility: 'invited', joinPolicy: 'anyone' },
  },
  {
    name: 'GuestSessionCreateInput',
    schema: GuestSessionCreateInputSchema,
    sample: { inviteToken: 'tok_room', displayName: 'Sam' },
    corrupt: { inviteToken: 'tok_room', displayName: 'S'.repeat(41) },
  },
  {
    name: 'PostCreateInput',
    schema: PostCreateInputSchema,
    sample: {
      type: 'text',
      text: 'Cooking dinner',
      audience: 'friends',
      placeId: null,
      media: [],
      parentPostId: null,
    },
    corrupt: {
      type: 'text',
      text: '   ',
      audience: 'friends',
      placeId: null,
      media: [],
      parentPostId: null,
    },
  },
  {
    name: 'LocationShareInput',
    schema: LocationShareInputSchema,
    sample: {
      audienceType: 'group',
      audienceId: GROUP,
      precision: 'precise',
      durationMinutes: 60,
      position: { lat: 37.76, lng: -122.42 },
    },
    corrupt: {
      audienceType: 'group',
      audienceId: GROUP,
      precision: 'precise',
      durationMinutes: 60 * 24 * 7,
      position: { lat: 37.76, lng: -122.42 },
    },
  },
  {
    name: 'HumanContextSetInput',
    schema: HumanContextSetInputSchema,
    sample: { currentCityId: CITY },
    corrupt: {},
  },
  {
    name: 'ReportInput',
    schema: ReportInputSchema,
    sample: { targetType: 'guest', targetId: GUEST, reason: 'harassment', details: null },
    corrupt: { targetType: 'guest', targetId: GUEST, reason: 'Harassment', details: null },
  },
]

describe('DTO schemas', () => {
  it.each(cases.map((c) => [c.name, c] as const))(
    '%s parses a sample and rejects a corrupt one',
    (_name, c) => {
      const ok = c.schema.safeParse(c.sample)
      expect(ok.success, ok.success ? '' : JSON.stringify(ok.error.issues)).toBe(true)
      expect(c.schema.safeParse(c.corrupt).success).toBe(false)
    },
  )

  it('strips unknown keys so newer servers do not break older clients', () => {
    const parsed = ClaimCompleteDtoSchema.parse({
      humanId: MAYA,
      groupId: GROUP,
      conversationId: CONVERSATION,
      extra: 'ignored',
    })
    expect(parsed).toEqual({ humanId: MAYA, groupId: GROUP, conversationId: CONVERSATION })
  })

  it('accepts Postgres to_jsonb timestamps and rejects naive ones', () => {
    expect(IsoDateTimeSchema.safeParse('2026-09-03T06:00:00.123456+00:00').success).toBe(true)
    expect(IsoDateTimeSchema.safeParse('2026-09-03T06:00:00Z').success).toBe(true)
    expect(IsoDateTimeSchema.safeParse('2026-09-03 06:00:00').success).toBe(false)
  })

  it('room participants must be exactly a Human or a Guest', () => {
    expect(
      RoomParticipantDtoSchema.safeParse({ ...participant, guestSessionId: GUEST }).success,
    ).toBe(false)
    expect(RoomParticipantDtoSchema.safeParse({ ...participant, humanId: null }).success).toBe(
      false,
    )
    expect(
      RoomParticipantDtoSchema.safeParse({ ...guestParticipant, isGuest: false }).success,
    ).toBe(false)
  })

  it('applies input defaults', () => {
    const sent = MessageSendInputSchema.parse({
      conversationId: CONVERSATION,
      clientId: CLIENT,
      type: 'image',
      text: null,
      replyToMessageId: null,
    })
    expect(sent.payload).toEqual({})
    const created = PostCreateInputSchema.parse({
      type: 'image',
      text: null,
      audience: 'city',
      placeId: PLACE,
      media: [
        {
          storageKey: 'media/1.jpg',
          mediaType: 'image',
          width: 10,
          height: 10,
          durationMs: null,
          provenance: 'uploaded',
        },
      ],
      parentPostId: null,
    })
    expect(created.replyPolicy).toBe('everyone_eligible')
    expect(created.resharePolicy).toBe('allowed_within_audience')
  })

  it('bounding boxes are [west, south, east, north]', () => {
    expect(BoundingBoxSchema.safeParse([-122.5, 37.7, -122.3, 37.8]).success).toBe(true)
    expect(BoundingBoxSchema.safeParse([-122.3, 37.7, -122.5, 37.8]).success).toBe(false)
  })

  it('helpers', () => {
    expect(isFlagEnabled({ X: { enabled: true, payload: null, updatedAt: AT } }, 'X')).toBe(true)
    expect(isFlagEnabled({}, 'X')).toBe(false)
    expect(activeParticipantCount({ participants: RoomDtoSchema.parse(room).participants })).toBe(2)
  })
})
