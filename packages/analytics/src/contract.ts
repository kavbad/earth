/**
 * Analytics event contract (EARTH_V1_SPEC.md PART XVI §97).
 *
 * `EVENT_NAMES` is the complete, grouped list of required events. `AnalyticsEventMap` gives every
 * event its property shape so `track('room_joined', …)` is checked at compile time. Property
 * values are ids, enums, counts, booleans and durations only — never exact GPS (§96), never
 * message/post/search text. Context ids named by §96 (`groupId`, `roomId`, `conversationId`,
 * `scope`) are event properties here; identity and base properties are merged in by the client
 * (`./identity.ts`, `./client.ts`).
 *
 * Spec property names are snake_case (`human_id`, `app_version`); this TypeScript contract uses
 * camelCase everywhere and the wire format is the camelCase key as-is.
 */
import type {
  Audience,
  ClaimIntent,
  ConversationId,
  ConversationType,
  GroupId,
  GroupKind,
  GroupMemberRole,
  GuestSessionId,
  HumanId,
  HumanPassStatus,
  MediaState,
  MediaType,
  MessageType,
  ParticipantRole,
  PostId,
  PostType,
  ReportReason,
  ReportTargetType,
  RoleKind,
  RoomContextType,
  RoomId,
  RoomJoinPolicy,
  RoomVisibility,
  Scope,
  ViewerRelation,
} from '@earth/domain'

import type { BasePropertyKey, IdentityPropertyKey } from './identity'

// ---------------------------------------------------------------------------
// Event names, grouped exactly as spec §97 groups them
// ---------------------------------------------------------------------------

export const EVENT_CATEGORIES = {
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
  live: [
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
} as const satisfies Record<string, readonly string[]>

export type EventCategory = keyof typeof EVENT_CATEGORIES
export const EVENT_CATEGORY_NAMES = Object.keys(EVENT_CATEGORIES) as readonly EventCategory[]

/** Every required event (spec §97), in spec order. */
export const EVENT_NAMES = [
  ...EVENT_CATEGORIES.membership,
  ...EVENT_CATEGORIES.groups,
  ...EVENT_CATEGORIES.messaging,
  ...EVENT_CATEGORIES.live,
  ...EVENT_CATEGORIES.feed,
  ...EVENT_CATEGORIES.social,
  ...EVENT_CATEGORIES.safety,
] as const

export type EventName = (typeof EVENT_NAMES)[number]

const EVENT_NAME_SET: ReadonlySet<string> = new Set<string>(EVENT_NAMES)

export function isEventName(value: unknown): value is EventName {
  return typeof value === 'string' && EVENT_NAME_SET.has(value)
}

export function categoryOfEvent(name: EventName): EventCategory {
  for (const category of EVENT_CATEGORY_NAMES) {
    const names: readonly string[] = EVENT_CATEGORIES[category]
    if (names.includes(name)) return category
  }
  // Unreachable: EVENT_NAMES is built from EVENT_CATEGORIES.
  throw new Error(`unknown analytics event: ${name}`)
}

// ---------------------------------------------------------------------------
// Supplementary value tuples used by property shapes (never string literals at call sites)
// ---------------------------------------------------------------------------

/** The three scoped surfaces (spec §51: Home feed, Live, Earth map). */
export const SCOPE_SURFACES = ['home', 'live', 'earth'] as const
export type ScopeSurface = (typeof SCOPE_SURFACES)[number]

/** Where an action originated. Used for `source` properties. */
export const SOURCE_SURFACES = [
  'home',
  'live',
  'earth',
  'messages',
  'group',
  'room',
  'profile',
  'post',
  'search',
  'notifications',
  'invite',
  'claim',
] as const
export type SourceSurface = (typeof SOURCE_SURFACES)[number]

/** How a Visitor arrived at the claim flow (spec §45–§47, §68). */
export const CLAIM_ENTRY_POINTS = [
  'public_world',
  'group_invite',
  'room_invite',
  'guest_room',
  'post',
  'profile',
  'launch',
] as const
export type ClaimEntryPoint = (typeof CLAIM_ENTRY_POINTS)[number]

/** Credential methods recorded in `auth_identities.provider` (ARCHITECTURE §4). */
export const AUTH_METHODS = ['phone', 'email', 'apple', 'google', 'passkey'] as const
export type AuthMethod = (typeof AUTH_METHODS)[number]

/** How an invite link left the app. */
export const SHARE_CHANNELS = ['copy_link', 'system_share', 'other'] as const
export type ShareChannel = (typeof SHARE_CHANNELS)[number]

/** How a Human ended up in a group. */
export const GROUP_ENTRY_MODES = ['joined', 'created'] as const
export type GroupEntryMode = (typeof GROUP_ENTRY_MODES)[number]

/** Outcome of a send attempt; `failed` feeds the failed-message-rate metric (spec §99). */
export const MESSAGE_SEND_OUTCOMES = ['sent', 'failed'] as const
export type MessageSendOutcome = (typeof MESSAGE_SEND_OUTCOMES)[number]

/** Channel a message arrived through (ARCHITECTURE §8 realtime with polling fallback). */
export const DELIVERY_CHANNELS = ['realtime', 'poll', 'push'] as const
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number]

/** Why a participant left a room. */
export const ROOM_LEAVE_REASONS = ['left', 'ended', 'removed', 'disconnected'] as const
export type RoomLeaveReason = (typeof ROOM_LEAVE_REASONS)[number]

/** Where a Live join was requested from. */
export const LIVE_JOIN_SOURCES = [
  'card',
  'map',
  'notification',
  'invite',
  'conversation',
  'group',
] as const
export type LiveJoinSource = (typeof LIVE_JOIN_SOURCES)[number]

/** Why a consent sheet was shown (ARCHITECTURE §10: join vs. widening). */
export const CONSENT_TRIGGERS = ['join', 'widen'] as const
export type ConsentTrigger = (typeof CONSENT_TRIGGERS)[number]

/** How a Guest session ended (spec §34). */
export const GUEST_OUTCOMES = ['left', 'room_ended', 'expired', 'removed', 'claimed'] as const
export type GuestOutcome = (typeof GUEST_OUTCOMES)[number]

/** What brought the feed on screen. */
export const FEED_OPEN_SOURCES = ['launch', 'tab', 'refresh', 'notification', 'deep_link'] as const
export type FeedOpenSource = (typeof FEED_OPEN_SOURCES)[number]

/** Role kinds a person can be in when opening an invite (the service role never does). */
export type ViewerRoleKind = Exclude<RoleKind, 'service'>

/** Verification outcomes that are not a pass (spec §19). */
export type VerificationFailureOutcome = Extract<HumanPassStatus, 'review_required' | 'rejected'>

/** Events that carry no properties are tracked with `{}`. */
export type NoProperties = Record<string, never>

// ---------------------------------------------------------------------------
// Property shapes
// ---------------------------------------------------------------------------

export type AnalyticsEventMap = {
  // Membership
  public_world_viewed: { surface: ScopeSurface; scope: Scope }
  claim_started: { entry: ClaimEntryPoint; hasGroupInvite: boolean }
  claim_group_join_selected: { groupId?: GroupId }
  claim_group_start_selected: NoProperties
  human_verification_started: { attempt: number }
  human_verification_passed: { attempt: number; durationMs: number }
  human_verification_failed: { attempt: number; outcome: VerificationFailureOutcome }
  human_claimed: {
    intent: ClaimIntent
    groupId?: GroupId
    /** Set when the Human was a Guest on this device first (Guest → Human conversion, §100). */
    guestSessionId?: GuestSessionId
    durationMs: number
  }
  account_recovery_started: { method: AuthMethod }

  // Groups
  group_created: { groupId: GroupId; kind: GroupKind; duringClaim: boolean }
  group_invite_shared: { groupId: GroupId; channel: ShareChannel }
  group_invite_opened: { groupId: GroupId; viewerState: ViewerRoleKind }
  group_joined: {
    groupId: GroupId
    viaInvite: boolean
    duringClaim: boolean
    /** Number of active memberships after this join (1 = first group). */
    memberGroupCount: number
  }
  group_left: { groupId: GroupId; role: GroupMemberRole }
  second_group_joined: { groupId: GroupId; mode: GroupEntryMode; daysSinceClaim: number }

  // Messaging
  message_sent: {
    conversationId: ConversationId
    conversationType: ConversationType
    groupId?: GroupId
    type: MessageType
    isReply: boolean
    outcome: MessageSendOutcome
  }
  message_received: {
    conversationId: ConversationId
    conversationType: ConversationType
    groupId?: GroupId
    type: MessageType
    via: DeliveryChannel
    /** Sender `created_at` → receiver render, for median delivery latency (§99). */
    deliveryLatencyMs: number
  }
  message_replied: {
    conversationId: ConversationId
    conversationType: ConversationType
    groupId?: GroupId
    type: MessageType
  }
  reaction_added: {
    conversationId: ConversationId
    conversationType: ConversationType
    groupId?: GroupId
  }
  voice_message_sent: {
    conversationId: ConversationId
    conversationType: ConversationType
    groupId?: GroupId
    durationMs: number
  }
  media_message_sent: {
    conversationId: ConversationId
    conversationType: ConversationType
    groupId?: GroupId
    mediaType: MediaType
    count: number
  }

  // Video / Live
  room_created: {
    roomId: RoomId
    contextType: RoomContextType
    groupId?: GroupId
    visibility: RoomVisibility
    joinPolicy: RoomJoinPolicy
  }
  room_joined: {
    roomId: RoomId
    mediaState: MediaState
    role: ParticipantRole
    contextType: RoomContextType
    groupId?: GroupId
    /** Active participants including the joiner (average room participants, §100). */
    participantCount: number
  }
  room_left: { roomId: RoomId; durationMs: number; reason: RoomLeaveReason }
  camera_enabled: { roomId: RoomId; previousMediaState: MediaState }
  audio_joined: { roomId: RoomId; previousMediaState: MediaState }
  room_visibility_changed: {
    roomId: RoomId
    from: RoomVisibility
    to: RoomVisibility
    joinPolicy: RoomJoinPolicy
    /** `false` when the change is pending participant consent (ARCHITECTURE §10). */
    applied: boolean
  }
  live_card_impression: {
    roomId: RoomId
    surface: ScopeSurface
    scope: Scope
    position: number
    participantCount: number
  }
  live_card_opened: { roomId: RoomId; surface: ScopeSurface; scope: Scope; position: number }
  live_join_requested: { roomId: RoomId; mediaState: MediaState; source: LiveJoinSource }
  participant_consent_shown: { roomId: RoomId; level: RoomVisibility; trigger: ConsentTrigger }
  participant_consent_accepted: { roomId: RoomId; level: RoomVisibility; trigger: ConsentTrigger }
  guest_room_opened: { roomId: RoomId; viewerState: ViewerRoleKind }
  guest_joined: { roomId: RoomId; guestSessionId: GuestSessionId; mediaState: MediaState }
  guest_room_completed: {
    roomId: RoomId
    guestSessionId: GuestSessionId
    durationMs: number
    outcome: GuestOutcome
  }

  // Feed
  feed_opened: { scope: Scope; surface: ScopeSurface; source: FeedOpenSource }
  scope_changed: { from: Scope; to: Scope; surface: ScopeSurface }
  post_impression: {
    postId: PostId
    scope: Scope
    audience: Audience
    position: number
    authorRelation: ViewerRelation
  }
  post_opened: { postId: PostId; scope?: Scope; source: SourceSurface }
  post_created: {
    postId: PostId
    type: PostType
    audience: Audience
    hasMedia: boolean
    hasPlace: boolean
  }
  post_reacted: { postId: PostId; scope?: Scope; audience: Audience }
  post_replied: { postId: PostId; audience: Audience; isNested: boolean }
  post_hidden: { postId: PostId; scope: Scope; audience: Audience; position: number }

  // Social
  friend_requested: { targetHumanId: HumanId; source: SourceSurface }
  friend_accepted: { requesterHumanId: HumanId; source: SourceSurface }
  follow_created: { targetHumanId: HumanId; source: SourceSurface }
  profile_viewed: { profileHumanId: HumanId; relation: ViewerRelation; source: SourceSurface }
  /** Never the query text. */
  search_performed: { queryLength: number; resultCount: number }

  // Safety
  human_blocked: { targetHumanId: HumanId; source: SourceSurface }
  content_reported: { targetType: ReportTargetType; reason: ReportReason }
  room_participant_removed: { roomId: RoomId; removedRole: ParticipantRole }
  guest_removed: { roomId: RoomId; guestSessionId: GuestSessionId }
}

export type EventProperties<E extends EventName> = AnalyticsEventMap[E]

// ---------------------------------------------------------------------------
// Compile-time completeness: the map must cover exactly EVENT_NAMES.
// ---------------------------------------------------------------------------

type MissingEvents = Exclude<EventName, keyof AnalyticsEventMap>
type ExtraEvents = Exclude<keyof AnalyticsEventMap, EventName>
type EventMapIsComplete = [MissingEvents] extends [never]
  ? [ExtraEvents] extends [never]
    ? true
    : never
  : never

/** Fails to compile when `AnalyticsEventMap` and `EVENT_NAMES` drift apart. */
export const EVENT_MAP_IS_COMPLETE = true satisfies EventMapIsComplete

// ---------------------------------------------------------------------------
// Compile-time reserved-key rules (see `IDENTITY_PROPERTY_KEYS` in ./identity.ts)
// ---------------------------------------------------------------------------

type BaseKeyCollisions = {
  [E in EventName]: Extract<keyof AnalyticsEventMap[E], BasePropertyKey>
}[EventName]
type IdentityKeyCollisions = {
  [E in EventName]: Extract<keyof AnalyticsEventMap[E], IdentityPropertyKey>
}[EventName]

/** Fails to compile when an event shape names `appVersion`, `platform` or `timestamp`. */
export const EVENT_MAP_HAS_NO_BASE_KEYS = true satisfies [BaseKeyCollisions] extends [never]
  ? true
  : never

/**
 * Fails to compile when an event shape names `humanId` or `anonymousVisitorId`; only
 * `guestSessionId` may be overridden by an event (guest_* events, human_claimed).
 */
export const EVENT_MAP_OVERRIDES_ONLY_GUEST_SESSION = true satisfies [
  IdentityKeyCollisions,
] extends ['guestSessionId']
  ? true
  : never
