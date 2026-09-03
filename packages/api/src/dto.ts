/**
 * Schemas owned by `@earth/api`: inputs that combine several `@earth/domain` inputs with extra RPC
 * arguments, and result shapes DB_API.md describes without a `@earth/domain` DTO (invite rows,
 * read receipts, review rows, ...). Everything a screen renders still comes from `@earth/domain`.
 */
import {
  AreaDtoSchema,
  AreaIdSchema,
  BIO_MAX,
  BoundingBoxSchema,
  ConversationIdSchema,
  ConversationsListDtoSchema,
  CursorSchema,
  DisplayNameSchema,
  FeatureFlagKeySchema,
  type FlagsDto,
  GROUP_NAME_MAX,
  GroupIdSchema,
  GroupInviteStatusSchema,
  GroupMemberRoleSchema,
  GroupMemberStatusSchema,
  GroupNameSchema,
  GuestSessionCreateInputSchema,
  GuestSessionDtoSchema,
  HandleSchema,
  HumanIdSchema,
  HumanPassStatusSchema,
  IsoDateTimeSchema,
  JsonObjectSchema,
  LatLngDtoSchema,
  MediaStateSchema,
  MessageIdSchema,
  MuteStateSchema,
  NonNegativeIntSchema,
  NotificationLevelSchema,
  NullableCursorSchema,
  NullableUrlSchema,
  PositiveIntSchema,
  PostCreateInputSchema,
  PostIdSchema,
  PostMediaInputSchema,
  PostViewDtoSchema,
  ProfileVisibilitySchema,
  PushPlatformSchema,
  RoomContextTypeSchema,
  RoomIdSchema,
  RoomRemoveParticipantInputSchema,
  RoomSetMediaStateInputSchema,
  RoomVisibilitySchema,
  ScopeSchema,
  SearchInputSchema,
  UrlSchema,
} from '@earth/domain'
import { z } from 'zod'

import { STORAGE_BUCKETS } from './rpc'

// ---------------------------------------------------------------------------
// Flags and settings (direct reads, DB_API §8)
// ---------------------------------------------------------------------------

/** One `feature_flags` row as PostgREST returns it. */
export const FeatureFlagRowSchema = z.object({
  key: FeatureFlagKeySchema,
  enabled: z.boolean(),
  payload: JsonObjectSchema.nullable(),
  updated_at: IsoDateTimeSchema,
})
export type FeatureFlagRow = z.infer<typeof FeatureFlagRowSchema>
export const FeatureFlagRowsSchema = z.array(FeatureFlagRowSchema)

export function flagsDtoFromRows(rows: readonly FeatureFlagRow[]): FlagsDto {
  const flags: FlagsDto = {}
  for (const row of rows) {
    flags[row.key] = { enabled: row.enabled, payload: row.payload, updatedAt: row.updated_at }
  }
  return flags
}

export const AppSettingRowSchema = z.object({ key: z.string().min(1), value: z.string() })
export const AppSettingRowsSchema = z.array(AppSettingRowSchema)

/** `app_settings` as a map (`public_storage_base_url`, `room_grace_seconds`, `web_origin`). */
export type SettingsDto = Readonly<Record<string, string>>

export function settingsFromRows(
  rows: readonly z.infer<typeof AppSettingRowSchema>[],
): SettingsDto {
  const settings: Record<string, string> = {}
  for (const row of rows) settings[row.key] = row.value
  return settings
}

// ---------------------------------------------------------------------------
// Claim and identity
// ---------------------------------------------------------------------------

/** `claim_verification_begin` result (DB_API §1). */
export const VerificationBeginDtoSchema = z.object({
  humanPassId: z.string().min(1),
  status: HumanPassStatusSchema.optional(),
})
export type VerificationBeginDto = z.infer<typeof VerificationBeginDtoSchema>

/** Body of `POST /api/claim/verification/start` (the server adds `humanId`/`humanPassId`). */
export const VerificationStartInputSchema = z.object({
  /** BCP 47 tag. */
  locale: z.string().min(2).default('en-US'),
  platform: PushPlatformSchema,
  /** Where a hosted flow sends the person back; absent for native SDK flows. */
  returnUrl: UrlSchema.optional(),
  /** Mock outcome selector (development only); real providers ignore it. */
  hint: z.string().min(1).optional(),
})
export type VerificationStartInput = z.input<typeof VerificationStartInputSchema>

/**
 * Result of `GET /api/claim/verification/:sessionId` (ARCHITECTURE §6): the recorded status and,
 * when it failed, why — never provider metadata. The server answers `{ sessionId, status,
 * failureKind }` (not the `VerificationSessionDto` of the start route). The `failureKind` values
 * (`technical` | `inconclusive` | `duplicate`) are owned by `@earth/auth`
 * (`VERIFICATION_FAILURE_KINDS`), which depends on this package, so they are typed here as a
 * non-empty string and narrowed by `@earth/auth` where the claim flow needs them.
 */
export const VerificationResultDtoSchema = z.object({
  sessionId: z.string().min(1),
  status: HumanPassStatusSchema,
  failureKind: z
    .string()
    .min(1)
    .nullish()
    .transform((value) => value ?? null),
})
export type VerificationResultDto = z.infer<typeof VerificationResultDtoSchema>

/**
 * A handle as typed or linked (`@Maya`, `MAYA`, ` maya `): handles are case-insensitive and stored
 * lowercase (`lower(handle)` unique index, DB_API §1), so lookups normalize before the strict
 * `HandleSchema` check. Only case, whitespace and a leading `@` are folded — never characters.
 */
export const HandleLookupSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^@/, '').toLowerCase())
  .pipe(HandleSchema)

/** `identity_reviews.kind` (DB_API §1). */
export const IDENTITY_REVIEW_KINDS = [
  'duplicate',
  'inconclusive',
  'help',
  'safety',
  'recovery',
] as const
export type IdentityReviewKind = (typeof IDENTITY_REVIEW_KINDS)[number]
export const IdentityReviewKindSchema = z.enum(IDENTITY_REVIEW_KINDS)

export const IDENTITY_REVIEW_STATUSES = ['open', 'approved', 'rejected'] as const
export type IdentityReviewStatus = (typeof IDENTITY_REVIEW_STATUSES)[number]
export const IdentityReviewStatusSchema = z.enum(IDENTITY_REVIEW_STATUSES)

export const IdentityReviewCreateInputSchema = z.object({
  kind: IdentityReviewKindSchema,
  details: JsonObjectSchema.default({}),
})
export type IdentityReviewCreateInput = z.input<typeof IdentityReviewCreateInputSchema>

export const IdentityReviewDtoSchema = z.object({
  id: z.uuid(),
  humanId: HumanIdSchema,
  kind: IdentityReviewKindSchema,
  status: IdentityReviewStatusSchema,
  createdAt: IsoDateTimeSchema,
})
export type IdentityReviewDto = z.infer<typeof IdentityReviewDtoSchema>

/** `identity_update(...)`: every field optional; omitted fields are left unchanged. */
export const IdentityUpdateInputSchema = z.object({
  displayName: DisplayNameSchema.nullish(),
  bio: z.string().trim().max(BIO_MAX).nullish(),
  avatarMediaId: z.uuid().nullish(),
  profileVisibility: ProfileVisibilitySchema.nullish(),
  publicCityVisibility: z.boolean().nullish(),
  homeCityAreaId: AreaIdSchema.nullish(),
})
export type IdentityUpdateInput = z.input<typeof IdentityUpdateInputSchema>

export const HandleAvailableDtoSchema = z.boolean()

// ---------------------------------------------------------------------------
// Media (storage upload + `media_objects` insert)
// ---------------------------------------------------------------------------

export const MEDIA_BUCKETS = [
  STORAGE_BUCKETS.avatars,
  STORAGE_BUCKETS.media,
  STORAGE_BUCKETS.voice,
] as const
export type MediaBucket = (typeof MEDIA_BUCKETS)[number]
export const MediaBucketSchema = z.enum(MEDIA_BUCKETS)

const CONTENT_TYPE_REGEX = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/

export const MediaUploadInputSchema = z.object({
  bucket: MediaBucketSchema,
  contentType: z.string().regex(CONTENT_TYPE_REGEX),
  width: PositiveIntSchema.nullish(),
  height: PositiveIntSchema.nullish(),
  durationMs: NonNegativeIntSchema.nullish(),
  byteSize: NonNegativeIntSchema.nullish(),
})
export type MediaUploadInput = z.input<typeof MediaUploadInputSchema>

/** A `media_objects` row as selected back after insert. */
export const MediaObjectRowSchema = z.object({
  id: z.uuid(),
  bucket: MediaBucketSchema,
  storage_key: z.string().min(1),
  content_type: z.string(),
})

export const MediaObjectDtoSchema = z.object({
  id: z.uuid(),
  bucket: MediaBucketSchema,
  storageKey: z.string().min(1),
  contentType: z.string(),
  /** Public URL for `avatars`; `null` for private buckets (use `media.signedUrl`). */
  url: NullableUrlSchema,
})
export type MediaObjectDto = z.infer<typeof MediaObjectDtoSchema>

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export const GroupUpdateInputSchema = z.object({
  groupId: GroupIdSchema,
  name: GroupNameSchema.nullish(),
  avatarMediaId: z.uuid().nullish(),
})
export type GroupUpdateInput = z.input<typeof GroupUpdateInputSchema>

/** One `group_invites_view` row (DB_API §2: the view never carries `token_hash`). */
export const GroupInviteRowSchema = z.object({
  id: z.uuid(),
  group_id: GroupIdSchema,
  created_by: HumanIdSchema,
  expires_at: IsoDateTimeSchema.nullable(),
  max_uses: NonNegativeIntSchema.nullable(),
  use_count: NonNegativeIntSchema,
  status: GroupInviteStatusSchema,
  created_at: IsoDateTimeSchema,
  revoked_at: IsoDateTimeSchema.nullable().optional(),
})
export const GroupInviteRowsSchema = z.array(GroupInviteRowSchema)

export const GroupInviteDtoSchema = z.object({
  id: z.uuid(),
  groupId: GroupIdSchema,
  createdByHumanId: HumanIdSchema,
  expiresAt: IsoDateTimeSchema.nullable(),
  maxUses: NonNegativeIntSchema.nullable(),
  useCount: NonNegativeIntSchema,
  status: GroupInviteStatusSchema,
  createdAt: IsoDateTimeSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
})
export type GroupInviteDto = z.infer<typeof GroupInviteDtoSchema>

export function groupInviteFromRow(row: z.infer<typeof GroupInviteRowSchema>): GroupInviteDto {
  return {
    id: row.id,
    groupId: row.group_id,
    createdByHumanId: row.created_by,
    expiresAt: row.expires_at,
    maxUses: row.max_uses,
    useCount: row.use_count,
    status: row.status,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? null,
  }
}

export const GroupInviteRevokeDtoSchema = z.object({
  id: z.uuid(),
  groupId: GroupIdSchema,
  status: GroupInviteStatusSchema,
  revokedAt: IsoDateTimeSchema.nullable(),
})
export type GroupInviteRevokeDto = z.infer<typeof GroupInviteRevokeDtoSchema>

/** `group_leave` (DB_API §2): ownership transfer / archive outcome. */
export const GroupLeaveDtoSchema = z.object({
  groupId: GroupIdSchema,
  left: z.boolean(),
  newOwnerHumanId: HumanIdSchema.nullable(),
  archived: z.boolean(),
})
export type GroupLeaveDto = z.infer<typeof GroupLeaveDtoSchema>

export const GroupMemberRemoveDtoSchema = z.object({
  groupId: GroupIdSchema,
  humanId: HumanIdSchema,
  status: GroupMemberStatusSchema,
})
export type GroupMemberRemoveDto = z.infer<typeof GroupMemberRemoveDtoSchema>

/**
 * `group_member_set_role` promotes/demotes moderators (DB_API §2); ownership only moves through
 * `group_leave`, so `owner` is refused before any round trip.
 */
export const AssignableGroupMemberRoleSchema = GroupMemberRoleSchema.exclude(['owner'])
export type AssignableGroupMemberRole = z.infer<typeof AssignableGroupMemberRoleSchema>

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

/** `conversations_list` (DB_API §2): summaries plus the keyset cursor (`last_message_at`). */
export const ConversationsPageDtoSchema = ConversationsListDtoSchema.extend({
  nextCursor: NullableCursorSchema.optional().transform((value) => value ?? null),
})
export type ConversationsPageDto = z.infer<typeof ConversationsPageDtoSchema>

export const ConversationsListInputSchema = z.object({
  cursor: CursorSchema.nullish(),
  limit: PositiveIntSchema.max(100).nullish(),
})
export type ConversationsListInput = z.input<typeof ConversationsListInputSchema>

export const ConversationPrefsInputSchema = z.object({
  conversationId: ConversationIdSchema,
  muteState: MuteStateSchema.nullish(),
  notificationLevel: NotificationLevelSchema.nullish(),
})
export type ConversationPrefsInput = z.input<typeof ConversationPrefsInputSchema>

export const ConversationPrefsDtoSchema = z.object({
  conversationId: ConversationIdSchema,
  muteState: MuteStateSchema,
  notificationLevel: NotificationLevelSchema,
})
export type ConversationPrefsDto = z.infer<typeof ConversationPrefsDtoSchema>

/** `conversation_read_receipts` (DB_API §2): "Seen by". */
export const ReadReceiptDtoSchema = z.object({
  humanId: HumanIdSchema,
  lastReadMessageId: MessageIdSchema.nullable(),
  lastReadAt: IsoDateTimeSchema.nullable().optional(),
})
export type ReadReceiptDto = z.infer<typeof ReadReceiptDtoSchema>
export const ReadReceiptsDtoSchema = z.array(ReadReceiptDtoSchema)

export const MessagesListInputSchema = z.object({
  conversationId: ConversationIdSchema,
  /** Keyset: messages older than this id. */
  beforeId: MessageIdSchema.nullish(),
  limit: PositiveIntSchema.max(200).nullish(),
})
export type MessagesListInput = z.input<typeof MessagesListInputSchema>

export const MessagesSinceInputSchema = z.object({
  conversationId: ConversationIdSchema,
  afterId: MessageIdSchema.nullable(),
})
export type MessagesSinceInput = z.input<typeof MessagesSinceInputSchema>

// ---------------------------------------------------------------------------
// Rooms and guests
// ---------------------------------------------------------------------------

export const RoomTitleSchema = z.string().trim().min(1).max(GROUP_NAME_MAX)

/** `room_start(context_type, context_id, title)`; the domain input covers the first two. */
export const RoomStartArgsSchema = z
  .object({
    contextType: RoomContextTypeSchema,
    contextId: z.uuid().nullable(),
    title: RoomTitleSchema.nullish(),
  })
  .refine((input) => input.contextType === 'standalone' || input.contextId !== null, {
    message: 'contextId is required unless contextType is standalone',
    path: ['contextId'],
  })
export type RoomStartArgs = z.input<typeof RoomStartArgsSchema>

export const RoomInviteJoinInputSchema = z.object({
  token: z.string().min(1),
  mediaState: MediaStateSchema,
  consentLevel: RoomVisibilitySchema,
})
export type RoomInviteJoinInput = z.input<typeof RoomInviteJoinInputSchema>

/** `room_set_media_state(room_id, media_state, consent_level)`; consent is optional when downgrading. */
export const RoomSetMediaStateArgsSchema = RoomSetMediaStateInputSchema.extend({
  consentLevel: RoomVisibilitySchema.nullish(),
})
export type RoomSetMediaStateArgs = z.input<typeof RoomSetMediaStateArgsSchema>

export const RoomRemoveParticipantArgsSchema = RoomRemoveParticipantInputSchema.extend({
  blockFromRoom: z.boolean().default(false),
})
export type RoomRemoveParticipantArgs = z.input<typeof RoomRemoveParticipantArgsSchema>

export const RoomEndInputSchema = z.object({
  roomId: RoomIdSchema,
  reason: z.string().trim().min(1).max(200).nullish(),
})
export type RoomEndInput = z.input<typeof RoomEndInputSchema>

export const RoomAdmitInputSchema = z.object({
  roomId: RoomIdSchema,
  participantId: z.uuid(),
})
export type RoomAdmitInput = z.input<typeof RoomAdmitInputSchema>

export const RoomGuestsDisabledInputSchema = z.object({
  roomId: RoomIdSchema,
  disabled: z.boolean(),
})
export type RoomGuestsDisabledInput = z.input<typeof RoomGuestsDisabledInputSchema>

/** `guest_session_create(token, display_name, device_fingerprint_hash[, media_state])`. */
export const GuestSessionCreateArgsSchema = GuestSessionCreateInputSchema.extend({
  deviceFingerprintHash: z.string().min(1).nullish(),
  mediaState: MediaStateSchema.nullish(),
})
export type GuestSessionCreateArgs = z.input<typeof GuestSessionCreateArgsSchema>

/** `guest_session_get` (DB_API §3): own sessions plus the "You've joined N rooms" counts. */
export const GuestSessionsDtoSchema = z.object({
  sessions: z.array(GuestSessionDtoSchema).default([]),
  roomsJoined: NonNegativeIntSchema.default(0),
  humansMet: NonNegativeIntSchema.default(0),
})
export type GuestSessionsDto = z.infer<typeof GuestSessionsDtoSchema>

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

/**
 * `post_create` takes `media uuid[]` (registered `media_objects`, DB_API §4), so each domain media
 * item also names the object `media.upload` registered for it.
 */
export const PostMediaArgsSchema = PostMediaInputSchema.extend({ mediaObjectId: z.uuid() })
export type PostMediaArgs = z.input<typeof PostMediaArgsSchema>

export const PostCreateArgsSchema = PostCreateInputSchema.safeExtend({
  media: z.array(PostMediaArgsSchema).max(10),
})
export type PostCreateArgs = z.input<typeof PostCreateArgsSchema>

export const PostReactionInputSchema = z.object({
  postId: PostIdSchema,
  /** `null` removes the viewer's reaction. */
  reaction: z.string().min(1).max(16).nullable(),
})
export type PostReactionInput = z.input<typeof PostReactionInputSchema>

export const PostRepliesInputSchema = z.object({
  postId: PostIdSchema,
  cursor: CursorSchema.nullish(),
  limit: PositiveIntSchema.max(100).nullish(),
})
export type PostRepliesInput = z.input<typeof PostRepliesInputSchema>

export const PostRepliesPageDtoSchema = z.object({
  replies: z.array(PostViewDtoSchema),
  nextCursor: NullableCursorSchema.optional().transform((value) => value ?? null),
})
export type PostRepliesPageDto = z.infer<typeof PostRepliesPageDtoSchema>

// ---------------------------------------------------------------------------
// Areas, places, location, map
// ---------------------------------------------------------------------------

/** `area_resolve(lat, lng)` (DB_API §5). */
export const AreaResolutionDtoSchema = z.object({
  neighborhood: AreaDtoSchema.nullable(),
  city: AreaDtoSchema.nullable(),
})
export type AreaResolutionDto = z.infer<typeof AreaResolutionDtoSchema>

/** `context_set(current_area_id, current_city_id, home_city_id)`; omitted fields are unchanged. */
export const ContextSetInputSchema = z.object({
  currentAreaId: AreaIdSchema.nullish(),
  currentCityId: AreaIdSchema.nullish(),
  homeCityId: AreaIdSchema.nullish(),
})
export type ContextSetInput = z.input<typeof ContextSetInputSchema>

/** `human_context.last_scope_<surface>` (DB_API §1). */
export const SCOPE_SURFACES = ['home', 'live', 'earth'] as const
export type ScopeSurface = (typeof SCOPE_SURFACES)[number]
export const ScopeSurfaceSchema = z.enum(SCOPE_SURFACES)

export const ScopeSetInputSchema = z.object({
  surface: ScopeSurfaceSchema,
  scope: ScopeSchema,
})
export type ScopeSetInput = z.input<typeof ScopeSetInputSchema>

export const LocationShareUpdateInputSchema = z.object({
  shareId: z.uuid(),
  position: LatLngDtoSchema,
})
export type LocationShareUpdateInput = z.input<typeof LocationShareUpdateInputSchema>

export const PlacesSearchInputSchema = z.object({
  q: SearchInputSchema.shape.q,
  areaId: AreaIdSchema.nullish(),
})
export type PlacesSearchInput = z.input<typeof PlacesSearchInputSchema>

export const PlaceCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  position: LatLngDtoSchema,
  areaId: AreaIdSchema,
  category: z.string().trim().min(1).max(60).nullish(),
})
export type PlaceCreateInput = z.input<typeof PlaceCreateInputSchema>

export const MapObjectsInputSchema = z.object({
  scope: ScopeSchema,
  bbox: BoundingBoxSchema,
})
export type MapObjectsInput = z.input<typeof MapObjectsInputSchema>

// ---------------------------------------------------------------------------
// Notifications and presence
// ---------------------------------------------------------------------------

export const NotificationsListInputSchema = z.object({
  cursor: CursorSchema.nullish(),
  limit: PositiveIntSchema.max(100).nullish(),
})
export type NotificationsListInput = z.input<typeof NotificationsListInputSchema>

/** `presence_ping(conversation_id, room_id, platform)` (DB_API §1). */
export const PresencePingArgsSchema = z.object({
  conversationId: ConversationIdSchema.nullish(),
  roomId: RoomIdSchema.nullish(),
  platform: PushPlatformSchema.nullish(),
})
export type PresencePingArgs = z.input<typeof PresencePingArgsSchema>

// ---------------------------------------------------------------------------
// Feed and live
// ---------------------------------------------------------------------------

export const FeedPageInputSchema = z.object({
  scope: ScopeSchema,
  cursor: CursorSchema.nullish(),
  areaId: AreaIdSchema.nullish(),
})
export type FeedPageInput = z.input<typeof FeedPageInputSchema>

export const LiveListInputSchema = z.object({
  scope: ScopeSchema,
  areaId: AreaIdSchema.nullish(),
})
export type LiveListInput = z.input<typeof LiveListInputSchema>

// ---------------------------------------------------------------------------
// Telemetry routes (structural: `@earth/analytics` / `@earth/observability` own the full schemas)
// ---------------------------------------------------------------------------

export const ANALYTICS_INGEST_VERSION = 1 as const
export const RTC_DIAGNOSTIC_ENVELOPE_VERSION = 1 as const

/** The batch `createFirstPartyProvider` posts (`AnalyticsIngestBatch` satisfies it). */
export const AnalyticsIngestBatchSchema = z.object({
  v: z.literal(ANALYTICS_INGEST_VERSION),
  sentAt: IsoDateTimeSchema,
  events: z
    .array(z.object({ name: z.string().min(1), properties: z.record(z.string(), z.unknown()) }))
    .min(1)
    .max(100),
})
export type AnalyticsIngestBatchLike = z.input<typeof AnalyticsIngestBatchSchema>

/** The envelope `createHttpRtcSink` posts (`RtcDiagnosticEnvelope` satisfies it). */
export const RtcDiagnosticEnvelopeSchema = z.object({
  v: z.literal(RTC_DIAGNOSTIC_ENVELOPE_VERSION),
  ts: IsoDateTimeSchema,
  event: z.object({ kind: z.string().min(1) }).loose(),
})
export type RtcDiagnosticEnvelopeLike = z.input<typeof RtcDiagnosticEnvelopeSchema>
