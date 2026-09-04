/**
 * Domain enums.
 *
 * Every Postgres enum type named in ARCHITECTURE.md §5 is mirrored here as an `as const`
 * tuple, a derived union type and a zod enum. Values are exactly the spec's
 * (EARTH_V1_SPEC.md PART III). `ENUM_REGISTRY` maps the exact Postgres enum type name to its
 * tuple so the database tests can assert that both lists are identical.
 *
 * Supplementary tuples (scopes, role kinds, notification types, ...) that are not Postgres
 * enum types live below the registry.
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Postgres enum mirrors (ARCHITECTURE §5)
// ---------------------------------------------------------------------------

/** `humans.status` — spec §16. */
export const HUMAN_STATUS = ['pending', 'active', 'restricted', 'suspended', 'deleted'] as const
export type HumanStatus = (typeof HUMAN_STATUS)[number]
export const HumanStatusSchema = z.enum(HUMAN_STATUS)

/** `humans.human_pass_status` — spec §16. */
export const HUMAN_PASS_STATUS = [
  'unverified',
  'verifying',
  'verified',
  'review_required',
  'rejected',
] as const
export type HumanPassStatus = (typeof HUMAN_PASS_STATUS)[number]
export const HumanPassStatusSchema = z.enum(HUMAN_PASS_STATUS)

/**
 * `humans.age_bracket` — spec §84. The result of identity verification, never a self-declaration:
 * the verification provider integration is the only writer (migration 1020) and no client can set
 * it. `unknown` is the default and behaves as it always has; `earth.age_policy_allows` refuses a
 * `minor` while `app_settings.minimum_age_policy` is `18_plus`.
 */
export const AGE_BRACKET = ['unknown', 'adult', 'minor'] as const
export type AgeBracket = (typeof AGE_BRACKET)[number]
export const AgeBracketSchema = z.enum(AGE_BRACKET)

/** `relationships.type` — spec §20. */
export const RELATIONSHIP_TYPE = ['follow', 'friend_pending', 'friend', 'familiar_private'] as const
export type RelationshipType = (typeof RELATIONSHIP_TYPE)[number]
export const RelationshipTypeSchema = z.enum(RELATIONSHIP_TYPE)

/** `groups.kind` — spec §22. */
export const GROUP_KIND = ['persistent', 'temporary'] as const
export type GroupKind = (typeof GROUP_KIND)[number]
export const GroupKindSchema = z.enum(GROUP_KIND)

/** `group_members.role` — spec §23. */
export const GROUP_MEMBER_ROLE = ['owner', 'moderator', 'member'] as const
export type GroupMemberRole = (typeof GROUP_MEMBER_ROLE)[number]
export const GroupMemberRoleSchema = z.enum(GROUP_MEMBER_ROLE)

/** `group_members.status` — spec §23. */
export const GROUP_MEMBER_STATUS = ['active', 'left', 'removed'] as const
export type GroupMemberStatus = (typeof GROUP_MEMBER_STATUS)[number]
export const GroupMemberStatusSchema = z.enum(GROUP_MEMBER_STATUS)

/** `conversations.type` — spec §25. */
export const CONVERSATION_TYPE = ['direct', 'group'] as const
export type ConversationType = (typeof CONVERSATION_TYPE)[number]
export const ConversationTypeSchema = z.enum(CONVERSATION_TYPE)

/** `messages.type` — spec §27. */
export const MESSAGE_TYPE = [
  'text',
  'image',
  'video',
  'audio',
  'file',
  'poll',
  'system',
  'place',
  'plan',
] as const
export type MessageType = (typeof MESSAGE_TYPE)[number]
export const MessageTypeSchema = z.enum(MESSAGE_TYPE)

/** `posts.type` — spec §29. */
export const POST_TYPE = ['text', 'image', 'video', 'moment'] as const
export type PostType = (typeof POST_TYPE)[number]
export const PostTypeSchema = z.enum(POST_TYPE)

/** `posts.audience` — spec §29. Who the author intended to reach; never merely ranking metadata. */
export const AUDIENCE = ['friends', 'neighborhood', 'city', 'world'] as const
export type Audience = (typeof AUDIENCE)[number]
export const AudienceSchema = z.enum(AUDIENCE)

/** `posts.reply_policy` — spec §29. */
export const REPLY_POLICY = ['everyone_eligible', 'friends', 'mentioned', 'none'] as const
export type ReplyPolicy = (typeof REPLY_POLICY)[number]
export const ReplyPolicySchema = z.enum(REPLY_POLICY)

/** `posts.reshare_policy` — spec §29. */
export const RESHARE_POLICY = ['allowed_within_audience', 'none'] as const
export type ResharePolicy = (typeof RESHARE_POLICY)[number]
export const ResharePolicySchema = z.enum(RESHARE_POLICY)

/** `rooms.context_type` — spec §32. */
export const ROOM_CONTEXT_TYPE = ['direct', 'group', 'event', 'place', 'standalone'] as const
export type RoomContextType = (typeof ROOM_CONTEXT_TYPE)[number]
export const RoomContextTypeSchema = z.enum(ROOM_CONTEXT_TYPE)

/** `rooms.visibility` — spec §32. Ordered narrow → wide (ARCHITECTURE §10). */
export const ROOM_VISIBILITY = [
  'invited',
  'group',
  'friends',
  'extended',
  'neighborhood',
  'city',
  'world',
] as const
export type RoomVisibility = (typeof ROOM_VISIBILITY)[number]
export const RoomVisibilitySchema = z.enum(ROOM_VISIBILITY)

/** `rooms.join_policy` — spec §32. */
export const ROOM_JOIN_POLICY = [
  'invited_only',
  'group',
  'friends',
  'friends_of_friends',
  'request',
  'anyone_with_link',
  'anyone',
] as const
export type RoomJoinPolicy = (typeof ROOM_JOIN_POLICY)[number]
export const RoomJoinPolicySchema = z.enum(ROOM_JOIN_POLICY)

/** `rooms.status` — spec §32. */
export const ROOM_STATUS = ['starting', 'active', 'ending', 'ended'] as const
export type RoomStatus = (typeof ROOM_STATUS)[number]
export const RoomStatusSchema = z.enum(ROOM_STATUS)

/** `rooms.area_precision` — spec §32. */
export const AREA_PRECISION = ['none', 'city', 'neighborhood', 'place'] as const
export type AreaPrecision = (typeof AREA_PRECISION)[number]
export const AreaPrecisionSchema = z.enum(AREA_PRECISION)

/** `room_participants.role` — spec §33. */
export const PARTICIPANT_ROLE = ['initiator', 'moderator', 'participant', 'viewer'] as const
export type ParticipantRole = (typeof PARTICIPANT_ROLE)[number]
export const ParticipantRoleSchema = z.enum(PARTICIPANT_ROLE)

/** `room_participants.media_state` — spec §33. */
export const MEDIA_STATE = ['watching', 'audio', 'camera'] as const
export type MediaState = (typeof MEDIA_STATE)[number]
export const MediaStateSchema = z.enum(MEDIA_STATE)

/** `room_participants.status` — spec §33. */
export const PARTICIPANT_STATUS = ['invited', 'waiting', 'active', 'left', 'removed'] as const
export type ParticipantStatus = (typeof PARTICIPANT_STATUS)[number]
export const ParticipantStatusSchema = z.enum(PARTICIPANT_STATUS)

/** `areas.type` — spec §37. */
export const AREA_TYPE = ['neighborhood', 'city', 'region', 'country'] as const
export type AreaType = (typeof AREA_TYPE)[number]
export const AreaTypeSchema = z.enum(AREA_TYPE)

/** `location_shares.audience_type` — spec §39. */
export const LOCATION_AUDIENCE_TYPE = ['friend', 'group', 'temporary_context'] as const
export type LocationAudienceType = (typeof LOCATION_AUDIENCE_TYPE)[number]
export const LocationAudienceTypeSchema = z.enum(LOCATION_AUDIENCE_TYPE)

/** `location_shares.precision` — spec §39. */
export const LOCATION_PRECISION = ['city', 'approximate', 'precise'] as const
export type LocationPrecision = (typeof LOCATION_PRECISION)[number]
export const LocationPrecisionSchema = z.enum(LOCATION_PRECISION)

/** `notifications.priority` — spec §40. */
export const NOTIFICATION_PRIORITY = ['critical_social', 'high', 'normal', 'low'] as const
export type NotificationPriority = (typeof NOTIFICATION_PRIORITY)[number]
export const NotificationPrioritySchema = z.enum(NOTIFICATION_PRIORITY)

/** `reports.reason` — spec §82, snake_cased in the spec's order. */
export const REPORT_REASON = [
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
] as const
export type ReportReason = (typeof REPORT_REASON)[number]
export const ReportReasonSchema = z.enum(REPORT_REASON)

/** Report reasons that receive priority handling (spec §82 "High-severity categories"). */
export const REPORT_REASON_HIGH_SEVERITY: ReadonlySet<ReportReason> = new Set<ReportReason>([
  'threats',
  'exploitation_minor_safety',
  'nonconsensual_imagery',
  'dangerous_location_stalking',
  'violence',
])

/** `reports.status` — spec §41 (values chosen by ARCHITECTURE §5 convention). */
export const REPORT_STATUS = ['open', 'in_review', 'resolved', 'dismissed'] as const
export type ReportStatus = (typeof REPORT_STATUS)[number]
export const ReportStatusSchema = z.enum(REPORT_STATUS)

/** `post_media.provenance` — spec §30. */
export const MEDIA_PROVENANCE = ['earth_capture', 'uploaded', 'edited', 'unknown'] as const
export type MediaProvenance = (typeof MEDIA_PROVENANCE)[number]
export const MediaProvenanceSchema = z.enum(MEDIA_PROVENANCE)

/** `public_identities.profile_visibility` — spec §17. */
export const PROFILE_VISIBILITY = ['public', 'limited', 'hidden'] as const
export type ProfileVisibility = (typeof PROFILE_VISIBILITY)[number]
export const ProfileVisibilitySchema = z.enum(PROFILE_VISIBILITY)

/**
 * Exact Postgres enum type names (ARCHITECTURE §5) → value tuples.
 * `supabase/tests` reads `pg_enum` and asserts equality with this object.
 */
export const ENUM_REGISTRY = {
  human_status: HUMAN_STATUS,
  human_pass_status: HUMAN_PASS_STATUS,
  age_bracket: AGE_BRACKET,
  relationship_type: RELATIONSHIP_TYPE,
  group_kind: GROUP_KIND,
  group_member_role: GROUP_MEMBER_ROLE,
  group_member_status: GROUP_MEMBER_STATUS,
  conversation_type: CONVERSATION_TYPE,
  message_type: MESSAGE_TYPE,
  post_type: POST_TYPE,
  audience: AUDIENCE,
  reply_policy: REPLY_POLICY,
  reshare_policy: RESHARE_POLICY,
  room_context_type: ROOM_CONTEXT_TYPE,
  room_visibility: ROOM_VISIBILITY,
  room_join_policy: ROOM_JOIN_POLICY,
  room_status: ROOM_STATUS,
  area_precision: AREA_PRECISION,
  participant_role: PARTICIPANT_ROLE,
  media_state: MEDIA_STATE,
  participant_status: PARTICIPANT_STATUS,
  area_type: AREA_TYPE,
  location_audience_type: LOCATION_AUDIENCE_TYPE,
  location_precision: LOCATION_PRECISION,
  notification_priority: NOTIFICATION_PRIORITY,
  report_reason: REPORT_REASON,
  report_status: REPORT_STATUS,
  media_provenance: MEDIA_PROVENANCE,
  profile_visibility: PROFILE_VISIBILITY,
} as const satisfies Record<string, readonly string[]>

export type PostgresEnumName = keyof typeof ENUM_REGISTRY
export const POSTGRES_ENUM_NAMES = Object.keys(ENUM_REGISTRY) as readonly PostgresEnumName[]

// ---------------------------------------------------------------------------
// Supplementary domain tuples (not Postgres enum types)
// ---------------------------------------------------------------------------

/** Browsing radius (spec §51/§52). A browsing context, not an author's audience permission. */
export const SCOPES = ['friends', 'neighborhood', 'city', 'world'] as const
export type Scope = (typeof SCOPES)[number]
export const ScopeSchema = z.enum(SCOPES)

/** `earth.current_role_kind()` — ARCHITECTURE §4. */
export const ROLE_KINDS = ['visitor', 'guest', 'claiming', 'human', 'service'] as const
export type RoleKind = (typeof ROLE_KINDS)[number]
export const RoleKindSchema = z.enum(ROLE_KINDS)

/** Exact V1 notification types (spec §86). */
export const NOTIFICATION_TYPES = [
  'direct_message',
  'group_message',
  'friend_live',
  'multi_live',
  'group_live',
  'friend_request',
  'friend_accepted',
  'follow',
  'group_invitation',
] as const
export type NotificationType = (typeof NOTIFICATION_TYPES)[number]
export const NotificationTypeSchema = z.enum(NOTIFICATION_TYPES)

/** `notifications.object_type` — the kind of object a notification points at. */
export const NOTIFICATION_OBJECT_TYPES = [
  'human',
  'group',
  'conversation',
  'message',
  'room',
  'post',
] as const
export type NotificationObjectType = (typeof NOTIFICATION_OBJECT_TYPES)[number]
export const NotificationObjectTypeSchema = z.enum(NOTIFICATION_OBJECT_TYPES)

/** `reports.target_type` (spec §41/§81). */
export const REPORT_TARGET_TYPES = ['human', 'post', 'room', 'message', 'guest', 'group'] as const
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number]
export const ReportTargetTypeSchema = z.enum(REPORT_TARGET_TYPES)

/** `groups.status` (spec §22 names the column; values by convention). */
export const GROUP_STATUSES = ['active', 'archived', 'deleted'] as const
export type GroupStatus = (typeof GROUP_STATUSES)[number]
export const GroupStatusSchema = z.enum(GROUP_STATUSES)

/** `group_invites.status` (spec §24). */
export const GROUP_INVITE_STATUSES = ['active', 'revoked', 'expired', 'exhausted'] as const
export type GroupInviteStatus = (typeof GROUP_INVITE_STATUSES)[number]
export const GroupInviteStatusSchema = z.enum(GROUP_INVITE_STATUSES)

/** `human_passes.risk_level` (spec §19). */
export const HUMAN_PASS_RISK_LEVELS = ['low', 'medium', 'high'] as const
export type HumanPassRiskLevel = (typeof HUMAN_PASS_RISK_LEVELS)[number]
export const HumanPassRiskLevelSchema = z.enum(HUMAN_PASS_RISK_LEVELS)

/** `conversation_members.mute_state` (spec §26). */
export const MUTE_STATES = ['none', 'muted'] as const
export type MuteState = (typeof MUTE_STATES)[number]
export const MuteStateSchema = z.enum(MUTE_STATES)

/** `conversation_members.notification_level` (spec §26). */
export const NOTIFICATION_LEVELS = ['all', 'mentions', 'none'] as const
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number]
export const NotificationLevelSchema = z.enum(NOTIFICATION_LEVELS)

/** `places.visibility` (spec §38). */
export const PLACE_VISIBILITIES = ['public', 'private'] as const
export type PlaceVisibility = (typeof PLACE_VISIBILITIES)[number]
export const PlaceVisibilitySchema = z.enum(PLACE_VISIBILITIES)

/** Claim flow intent (spec §45/§46). */
export const CLAIM_INTENTS = ['start_group', 'join_group'] as const
export type ClaimIntent = (typeof CLAIM_INTENTS)[number]
export const ClaimIntentSchema = z.enum(CLAIM_INTENTS)

/**
 * Claim flow step as seen by the client state machine (`@earth/auth`) and returned by `claim_get()`
 * (`claimed` once the Human is active — DB_API §1). Verification detail (review required, rejected)
 * is carried by `ClaimStateDto.verification.status`.
 */
export const CLAIM_STATUSES = [
  'started',
  'identity_set',
  'verifying',
  'verified',
  'claimed',
] as const
export type ClaimStatus = (typeof CLAIM_STATUSES)[number]
export const ClaimStatusSchema = z.enum(CLAIM_STATUSES)

/** Friend request state between the viewer and another Human, from the viewer's side. */
export const FRIEND_REQUEST_STATES = ['none', 'sent', 'received'] as const
export type FriendRequestState = (typeof FRIEND_REQUEST_STATES)[number]
export const FriendRequestStateSchema = z.enum(FRIEND_REQUEST_STATES)

/** Relation of a room participant to the viewer (spec §60 ordering, most relevant first). */
export const VIEWER_RELATIONS = ['self', 'friend', 'shared_group', 'familiar', 'other'] as const
export type ViewerRelation = (typeof VIEWER_RELATIONS)[number]
export const ViewerRelationSchema = z.enum(VIEWER_RELATIONS)

/** Feed card kinds (ARCHITECTURE §9). */
export const FEED_CARD_KINDS = ['post', 'live', 'presence'] as const
export type FeedCardKind = (typeof FEED_CARD_KINDS)[number]
export const FeedCardKindSchema = z.enum(FEED_CARD_KINDS)

/** Presence row item kinds (SCREEN 02: "Xavier + Maya live", "Weekend Crew · 3 active", "Sarah nearby"). */
export const PRESENCE_ITEM_TYPES = ['friends_live', 'group_active', 'friend_nearby'] as const
export type PresenceItemType = (typeof PRESENCE_ITEM_TYPES)[number]
export const PresenceItemTypeSchema = z.enum(PRESENCE_ITEM_TYPES)

/** Storage media types for posts/messages. */
export const MEDIA_TYPES = ['image', 'video', 'audio'] as const
export type MediaType = (typeof MEDIA_TYPES)[number]
export const MediaTypeSchema = z.enum(MEDIA_TYPES)

/** Push token platforms (`push_tokens.platform`, ARCHITECTURE §11). */
export const PUSH_PLATFORMS = ['ios', 'android', 'web'] as const
export type PushPlatform = (typeof PUSH_PLATFORMS)[number]
export const PushPlatformSchema = z.enum(PUSH_PLATFORMS)
