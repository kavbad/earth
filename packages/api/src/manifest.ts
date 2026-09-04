/**
 * The call manifest: every `EarthClient` method with the RPC or server route it reaches, the
 * argument names it sends and the DTO it parses the result with.
 *
 * This file is the single source of truth. Namespaces do not spell RPC names, argument names or
 * result schemas themselves: they call `transport.call(CALLS.x, args)` / `transport.route(...)`,
 * where the argument object must have exactly the keys the spec lists (a compile-time check) and
 * the result is parsed with the spec's schema. `RPC_MANIFEST` is the same list without schemas —
 * for documentation, `README.md` and `supabase/tests/src/verify/api-parity.test.ts`, which checks
 * every RPC entry against `pg_proc` and against the results of a seeded world.
 *
 * `args` are the RPC's snake_case parameter names in the order the client sends them; for routes
 * they are the query parameters (GET), the JSON body's top-level fields (POST) or the path
 * parameters; for direct table access, the columns.
 */
import {
  AreaDtoSchema,
  BlockDtoSchema,
  BlocksListDtoSchema,
  ClaimCompleteDtoSchema,
  ClaimStateDtoSchema,
  ConversationDetailDtoSchema,
  ConversationSummaryDtoSchema,
  FeedPageDtoSchema,
  GroupDetailDtoSchema,
  GroupDtoSchema,
  GroupInviteCreateDtoSchema,
  GroupInvitePreviewDtoSchema,
  GroupJoinDtoSchema,
  GroupMemberDtoSchema,
  GuestSessionDtoSchema,
  HumanContextDtoSchema,
  LiveListDtoSchema,
  LocationShareDtoSchema,
  MapFriendDtoSchema,
  MapObjectsDtoSchema,
  MeDtoSchema,
  MessageDtoSchema,
  MessagesPageDtoSchema,
  NotificationsPageDtoSchema,
  PlaceDtoSchema,
  type PostDto,
  PostDetailDtoSchema,
  PostViewDtoSchema,
  ProfileDtoSchema,
  PublicIdentityDtoSchema,
  RelationshipChangeDtoSchema,
  ReportDtoSchema,
  RoomDtoSchema,
  RoomInviteCreateDtoSchema,
  RoomInvitePreviewDtoSchema,
  RoomLeaveDtoSchema,
  RoomStartDtoSchema,
  RoomTokenDtoSchema,
  RoomVisibilityChangeDtoSchema,
  SearchResultsDtoSchema,
  VerificationSessionDtoSchema,
} from '@earth/domain'
import { z } from 'zod'

import {
  AccountDeleteDtoSchema,
  AreaResolutionDtoSchema,
  BlockChangeDtoSchema,
  ConversationPrefsDtoSchema,
  ConversationReadStateDtoSchema,
  ConversationsPageDtoSchema,
  GroupInviteRevokeDtoSchema,
  GroupLeaveDtoSchema,
  GroupMemberRemoveDtoSchema,
  GuestSessionsDtoSchema,
  HandleAvailableDtoSchema,
  IdentityReviewDtoSchema,
  PostReactionDtoSchema,
  PostRepliesPageDtoSchema,
  PostsByAuthorPageDtoSchema,
  ReadReceiptsDtoSchema,
  UnreadCountDtoSchema,
  VerificationBeginDtoSchema,
  VerificationResultDtoSchema,
} from './dto'
import { ROUTE_TEMPLATES, RPC, type RpcName, TABLES, type TableName } from './rpc'
import { arrayOrKeyed } from './schemas'

// ---------------------------------------------------------------------------
// Spec types
// ---------------------------------------------------------------------------

export type ArgNames = readonly string[]

/** The argument object a spec's call site must pass: exactly the spec's names, any values. */
export type ArgsOf<A extends ArgNames> = { readonly [K in A[number]]: unknown }

export const CALL_KINDS = ['rpc', 'route', 'table', 'composite'] as const
export type CallKind = (typeof CALL_KINDS)[number]

export const ROUTE_METHODS = ['GET', 'POST'] as const
export type RouteMethod = (typeof ROUTE_METHODS)[number]

export const ROUTE_AUTH_MODES = ['required', 'optional'] as const
export type RouteAuthMode = (typeof ROUTE_AUTH_MODES)[number]

interface SpecBase<A extends ArgNames> {
  /** Client method path (`posts.create`, `groups.invites.join`). */
  readonly method: string
  readonly args: A
  /** Name of the DTO schema the result is parsed with, or `void` when the result is ignored. */
  readonly result: string
  readonly notes?: string
}

/** A `supabase.rpc(name, args)` call parsed with `schema` (`null` = result ignored). */
export interface RpcSpec<A extends ArgNames = ArgNames, T = unknown> extends SpecBase<A> {
  readonly kind: 'rpc'
  readonly rpc: RpcName
  readonly schema: z.ZodType<T> | null
}

/** A `fetch` to a server-tier route parsed with `schema` (`null` = body ignored). */
export interface RouteSpec<A extends ArgNames = ArgNames, T = unknown> extends SpecBase<A> {
  readonly kind: 'route'
  readonly httpMethod: RouteMethod
  /** Path template relative to `serverBaseUrl`; `:name` segments are path parameters. */
  readonly path: string
  readonly auth: RouteAuthMode
  readonly schema: z.ZodType<T> | null
}

/** A direct, RLS-governed table/view access through PostgREST. */
export interface TableSpec<A extends ArgNames = ArgNames> extends SpecBase<A> {
  readonly kind: 'table'
  readonly table: TableName
  readonly operation: 'select' | 'insert'
}

/** A method built on other methods (or on storage) with no call of its own. */
export interface CompositeSpec<A extends ArgNames = ArgNames> extends SpecBase<A> {
  readonly kind: 'composite'
  readonly via: readonly string[]
}

export type CallSpec = RpcSpec | RouteSpec | TableSpec | CompositeSpec

function rpc<const A extends ArgNames, T>(
  method: string,
  name: RpcName,
  args: A,
  result: string,
  schema: z.ZodType<T>,
  notes?: string,
): RpcSpec<A, T> {
  return notes === undefined
    ? { kind: 'rpc', method, rpc: name, args, result, schema }
    : { kind: 'rpc', method, rpc: name, args, result, schema, notes }
}

function rpcVoid<const A extends ArgNames>(
  method: string,
  name: RpcName,
  args: A,
  notes?: string,
): RpcSpec<A, void> {
  return notes === undefined
    ? { kind: 'rpc', method, rpc: name, args, result: 'void', schema: null }
    : { kind: 'rpc', method, rpc: name, args, result: 'void', schema: null, notes }
}

function route<const A extends ArgNames, T>(
  method: string,
  httpMethod: RouteMethod,
  path: string,
  args: A,
  auth: RouteAuthMode,
  result: string,
  schema: z.ZodType<T> | null,
  notes?: string,
): RouteSpec<A, T> {
  return notes === undefined
    ? { kind: 'route', method, httpMethod, path, args, auth, result, schema }
    : { kind: 'route', method, httpMethod, path, args, auth, result, schema, notes }
}

function routeVoid<const A extends ArgNames>(
  method: string,
  httpMethod: RouteMethod,
  path: string,
  args: A,
  auth: RouteAuthMode,
  notes?: string,
): RouteSpec<A, void> {
  return route<A, void>(method, httpMethod, path, args, auth, 'void', null, notes)
}

function table<const A extends ArgNames>(
  method: string,
  name: TableName,
  operation: TableSpec['operation'],
  args: A,
  result: string,
  notes?: string,
): TableSpec<A> {
  return notes === undefined
    ? { kind: 'table', method, table: name, operation, args, result }
    : { kind: 'table', method, table: name, operation, args, result, notes }
}

function composite(
  method: string,
  via: readonly string[],
  result: string,
  notes?: string,
): CompositeSpec<readonly []> {
  return notes === undefined
    ? { kind: 'composite', method, via, args: [], result }
    : { kind: 'composite', method, via, args: [], result, notes }
}

// ---------------------------------------------------------------------------
// Result schemas that adapt a wire shape (kept next to the specs that use them)
// ---------------------------------------------------------------------------

/** `post_create` returns `PostViewDto` (DB_API §4, `earth.post_json`); the client hands back its `post`. */
export const PostCreateResultSchema = PostViewDtoSchema.transform((view): PostDto => view.post)

export const PostRepliesResultSchema = z.union([
  PostRepliesPageDtoSchema,
  z.array(PostViewDtoSchema).transform((replies) => ({ replies, nextCursor: null })),
])

export const BlocksResultSchema = z.union([
  BlocksListDtoSchema,
  z.array(BlockDtoSchema).transform((blocks) => ({ blocks })),
])

export const MessagesSinceResultSchema = arrayOrKeyed(MessageDtoSchema, 'messages')
export const ReportsResultSchema = arrayOrKeyed(ReportDtoSchema, 'reports')
export const PlacesResultSchema = arrayOrKeyed(PlaceDtoSchema, 'places')
export const AreasResultSchema = arrayOrKeyed(AreaDtoSchema, 'areas')
export const SharesResultSchema = arrayOrKeyed(MapFriendDtoSchema, 'shares')
export const MySharesResultSchema = arrayOrKeyed(LocationShareDtoSchema, 'shares')

const FLAG_COLUMNS = ['key', 'enabled', 'payload', 'updated_at'] as const
const SETTING_COLUMNS = ['key', 'value'] as const
const INVITE_COLUMNS = [
  'id',
  'group_id',
  'created_by',
  'expires_at',
  'max_uses',
  'use_count',
  'status',
  'created_at',
  'revoked_at',
] as const
const MEDIA_OBJECT_COLUMNS = [
  'owner_human_id',
  'bucket',
  'storage_key',
  'content_type',
  'width',
  'height',
  'duration_ms',
  'byte_size',
] as const

// ---------------------------------------------------------------------------
// The calls, one per client method, in the order of ARCHITECTURE §7
// ---------------------------------------------------------------------------

export const CALLS = {
  // flags, settings, me
  flagsGet: table(
    'flags.get',
    TABLES.featureFlags,
    'select',
    FLAG_COLUMNS,
    'FlagsDto',
    'rows parsed with FeatureFlagRowSchema, keyed by flag',
  ),
  flagsResolved: table(
    'flags.resolved',
    TABLES.featureFlags,
    'select',
    FLAG_COLUMNS,
    'FeatureFlags',
    'same rows through resolveFlags (@earth/config)',
  ),
  settingsGet: table(
    'settings.get',
    TABLES.appSettings,
    'select',
    SETTING_COLUMNS,
    'SettingsDto',
    'rows parsed with AppSettingRowSchema, keyed by setting',
  ),
  meGet: rpc('me.get', RPC.meGet, [], 'MeDto', MeDtoSchema),

  // claim
  claimStart: rpc(
    'claim.start',
    RPC.claimStart,
    ['intent', 'group_label', 'invite_token'],
    'ClaimStateDto',
    ClaimStateDtoSchema,
  ),
  claimGet: rpc('claim.get', RPC.claimGet, [], 'ClaimStateDto', ClaimStateDtoSchema),
  claimSetIdentity: rpc(
    'claim.setIdentity',
    RPC.claimSetIdentity,
    ['display_name', 'handle', 'avatar_media_id'],
    'ClaimStateDto',
    ClaimStateDtoSchema,
  ),
  claimBeginVerification: rpc(
    'claim.beginVerification',
    RPC.claimVerificationBegin,
    ['provider'],
    'VerificationBeginDto',
    VerificationBeginDtoSchema,
    'provider is sent only when given (the RPC defaults it)',
  ),
  claimStartVerification: route(
    'claim.startVerification',
    'POST',
    ROUTE_TEMPLATES.claimVerificationStart,
    ['locale', 'platform', 'returnUrl', 'hint'],
    'required',
    'VerificationSessionDto',
    VerificationSessionDtoSchema,
    'JSON body',
  ),
  claimPollVerification: route(
    'claim.pollVerification',
    'GET',
    ROUTE_TEMPLATES.claimVerificationResult,
    ['sessionId'],
    'required',
    'VerificationResultDto',
    VerificationResultDtoSchema,
    'path parameter',
  ),
  claimVerificationResult: composite(
    'claim.verificationResult',
    ['claim.pollVerification'],
    'VerificationResultDto',
    'alias',
  ),
  claimComplete: rpc(
    'claim.complete',
    RPC.claimComplete,
    [],
    'ClaimCompleteDto',
    ClaimCompleteDtoSchema,
  ),
  claimCreateReview: rpc(
    'claim.createReview',
    RPC.identityReviewCreate,
    ['kind', 'details'],
    'IdentityReviewDto',
    IdentityReviewDtoSchema,
  ),

  // identity, media
  identityUpdate: rpc(
    'identity.update',
    RPC.identityUpdate,
    [
      'display_name',
      'bio',
      'avatar_media_id',
      'profile_visibility',
      'public_city_visibility',
      'home_city_area_id',
      'handle',
    ],
    'PublicIdentityDto',
    PublicIdentityDtoSchema,
    'handle changes the handle (handle_invalid / handle_taken); null leaves it',
  ),
  identityDeleteAccount: route(
    'identity.deleteAccount',
    'POST',
    ROUTE_TEMPLATES.accountDelete,
    [],
    'required',
    'AccountDeleteDto',
    AccountDeleteDtoSchema,
    'empty JSON body; the server runs human_delete_request as the caller, then deletes the credential',
  ),
  identityHandleAvailable: rpc(
    'identity.handleAvailable',
    RPC.handleAvailable,
    ['handle'],
    'HandleAvailableDto',
    HandleAvailableDtoSchema,
    'after case/@ normalization; a handle malformed beyond that is false without a round trip',
  ),
  identityUploadAvatar: composite(
    'identity.uploadAvatar',
    ['media.upload'],
    'MediaObjectDto',
    'into the avatars bucket',
  ),
  mediaUpload: table(
    'media.upload',
    TABLES.mediaObjects,
    'insert',
    MEDIA_OBJECT_COLUMNS,
    'MediaObjectDto',
    'me.get for the owner, storage.from(bucket).upload(<human_id>/<random>.<ext>), then the insert (RLS: own); getPublicUrl for avatars',
  ),
  mediaSignedUrl: composite('media.signedUrl', ['storage.from(bucket).createSignedUrl'], 'string'),

  // groups
  groupsCreate: rpc('groups.create', RPC.groupCreate, ['name'], 'GroupDto', GroupDtoSchema),
  groupsGet: rpc('groups.get', RPC.groupGet, ['group_id'], 'GroupDetailDto', GroupDetailDtoSchema),
  groupsUpdate: rpc(
    'groups.update',
    RPC.groupUpdate,
    ['group_id', 'name', 'avatar_media_id'],
    'GroupDto',
    GroupDtoSchema,
  ),
  groupsLeave: rpc(
    'groups.leave',
    RPC.groupLeave,
    ['group_id'],
    'GroupLeaveDto',
    GroupLeaveDtoSchema,
  ),
  groupsInvitesCreate: rpc(
    'groups.invites.create',
    RPC.groupInviteCreate,
    ['group_id', 'expires_in_seconds', 'max_uses'],
    'GroupInviteCreateDto',
    GroupInviteCreateDtoSchema,
  ),
  groupsInvitesRevoke: rpc(
    'groups.invites.revoke',
    RPC.groupInviteRevoke,
    ['invite_id'],
    'GroupInviteRevokeDto',
    GroupInviteRevokeDtoSchema,
  ),
  groupsInvitesPreview: rpc(
    'groups.invites.preview',
    RPC.groupInvitePreview,
    ['token'],
    'GroupInvitePreviewDto',
    GroupInvitePreviewDtoSchema,
  ),
  groupsInvitesJoin: rpc(
    'groups.invites.join',
    RPC.groupInviteJoin,
    ['token'],
    'GroupJoinDto',
    GroupJoinDtoSchema,
  ),
  groupsInvitesList: table(
    'groups.invites.list',
    TABLES.groupInvitesView,
    'select',
    INVITE_COLUMNS,
    'GroupInviteDto[]',
    'where group_id = ? order by created_at desc; rows parsed with GroupInviteRowSchema',
  ),
  groupsMembersRemove: rpc(
    'groups.members.remove',
    RPC.groupMemberRemove,
    ['group_id', 'human_id'],
    'GroupMemberRemoveDto',
    GroupMemberRemoveDtoSchema,
  ),
  groupsMembersSetRole: rpc(
    'groups.members.setRole',
    RPC.groupMemberSetRole,
    ['group_id', 'human_id', 'role'],
    'GroupMemberDto',
    GroupMemberDtoSchema,
    'moderator or member; ownership moves only through group_leave',
  ),

  // conversations
  conversationsList: rpc(
    'conversations.list',
    RPC.conversationsList,
    ['cursor', 'limit'],
    'ConversationsPageDto',
    ConversationsPageDtoSchema,
    'cursor is the previous page nextCursor (a timestamptz, last_message_at)',
  ),
  conversationsGet: rpc(
    'conversations.get',
    RPC.conversationGet,
    ['conversation_id'],
    'ConversationDetailDto',
    ConversationDetailDtoSchema,
  ),
  conversationsDirectWith: rpc(
    'conversations.directWith',
    RPC.conversationDirectGetOrCreate,
    ['other_human_id'],
    'ConversationSummaryDto',
    ConversationSummaryDtoSchema,
  ),
  conversationsCreateGroup: rpc(
    'conversations.createGroup',
    RPC.conversationGroupCreate,
    ['human_ids'],
    'ConversationSummaryDto',
    ConversationSummaryDtoSchema,
    'two or more others',
  ),
  conversationsCreate: composite(
    'conversations.create',
    ['conversations.directWith', 'conversations.createGroup'],
    'ConversationSummaryDto',
    'one Human → directWith, more → createGroup',
  ),
  conversationsSetPrefs: rpc(
    'conversations.setPrefs',
    RPC.conversationSetPrefs,
    ['conversation_id', 'mute_state', 'notification_level'],
    'ConversationPrefsDto',
    ConversationPrefsDtoSchema,
  ),
  conversationsReadReceipts: rpc(
    'conversations.readReceipts',
    RPC.conversationReadReceipts,
    ['conversation_id'],
    'ReadReceiptDto[]',
    ReadReceiptsDtoSchema,
  ),
  conversationsMarkRead: rpc(
    'conversations.markRead',
    RPC.conversationMarkRead,
    ['conversation_id', 'message_id'],
    'ConversationReadStateDto',
    ConversationReadStateDtoSchema,
  ),
  messagesList: rpc(
    'conversations.messages.list',
    RPC.messagesList,
    ['conversation_id', 'before_id', 'limit'],
    'MessagesPageDto',
    MessagesPageDtoSchema,
  ),
  messagesSince: rpc(
    'conversations.messages.since',
    RPC.messagesSince,
    ['conversation_id', 'after_id'],
    'MessageDto[]',
    MessagesSinceResultSchema,
    '{ messages, nextCursor } or a bare array is accepted; a JSON null reads as []',
  ),
  messagesSend: rpc(
    'conversations.messages.send',
    RPC.messageSend,
    ['conversation_id', 'client_id', 'type', 'text', 'payload', 'reply_to_message_id'],
    'MessageDto',
    MessageDtoSchema,
    'idempotent on client_id',
  ),
  messagesEdit: rpc(
    'conversations.messages.edit',
    RPC.messageEdit,
    ['message_id', 'text'],
    'MessageDto',
    MessageDtoSchema,
  ),
  messagesDelete: rpc(
    'conversations.messages.delete',
    RPC.messageDelete,
    ['message_id'],
    'MessageDto',
    MessageDtoSchema,
    'the tombstone',
  ),
  messagesReactionsToggle: rpc(
    'conversations.messages.reactions.toggle',
    RPC.messageReactionToggle,
    ['message_id', 'reaction'],
    'MessageDto',
    MessageDtoSchema,
  ),

  // rooms, guest
  roomsStart: rpc(
    'rooms.start',
    RPC.roomStart,
    ['context_type', 'context_id', 'title'],
    'RoomStartDto',
    RoomStartDtoSchema,
  ),
  roomsGet: rpc('rooms.get', RPC.roomGet, ['room_id'], 'RoomDto', RoomDtoSchema),
  roomsJoin: rpc(
    'rooms.join',
    RPC.roomJoin,
    ['room_id', 'media_state', 'consent_level'],
    'RoomDto',
    RoomDtoSchema,
  ),
  roomsJoinWithInvite: rpc(
    'rooms.joinWithInvite',
    RPC.roomInviteJoin,
    ['token', 'media_state', 'consent_level'],
    'RoomDto',
    RoomDtoSchema,
  ),
  roomsSetMediaState: rpc(
    'rooms.setMediaState',
    RPC.roomSetMediaState,
    ['room_id', 'media_state', 'consent_level'],
    'RoomVisibilityChangeDto',
    RoomVisibilityChangeDtoSchema,
    'consent_level null when downgrading',
  ),
  roomsConsent: rpc(
    'rooms.consent',
    RPC.roomConsent,
    ['room_id', 'level'],
    'RoomVisibilityChangeDto',
    RoomVisibilityChangeDtoSchema,
  ),
  roomsSetVisibility: rpc(
    'rooms.setVisibility',
    RPC.roomSetVisibility,
    ['room_id', 'visibility', 'join_policy'],
    'RoomVisibilityChangeDto',
    RoomVisibilityChangeDtoSchema,
  ),
  roomsSetJoinPolicy: rpc(
    'rooms.setJoinPolicy',
    RPC.roomSetJoinPolicy,
    ['room_id', 'join_policy'],
    'RoomDto',
    RoomDtoSchema,
  ),
  roomsSetGuestsDisabled: rpc(
    'rooms.setGuestsDisabled',
    RPC.roomSetGuestsDisabled,
    ['room_id', 'disabled'],
    'RoomDto',
    RoomDtoSchema,
  ),
  roomsAdmit: rpc(
    'rooms.admit',
    RPC.roomAdmit,
    ['room_id', 'participant_id'],
    'RoomDto',
    RoomDtoSchema,
  ),
  roomsLeave: rpc('rooms.leave', RPC.roomLeave, ['room_id'], 'RoomLeaveDto', RoomLeaveDtoSchema),
  roomsEnd: rpc('rooms.end', RPC.roomEnd, ['room_id', 'reason'], 'RoomDto', RoomDtoSchema),
  roomsRemoveParticipant: rpc(
    'rooms.removeParticipant',
    RPC.roomRemoveParticipant,
    ['room_id', 'participant_id', 'block_from_room'],
    'RoomDto',
    RoomDtoSchema,
  ),
  roomsInvitesCreate: rpc(
    'rooms.invites.create',
    RPC.roomInviteCreate,
    ['room_id', 'expires_in_seconds', 'join_policy_override'],
    'RoomInviteCreateDto',
    RoomInviteCreateDtoSchema,
  ),
  roomsInvitesPreview: rpc(
    'rooms.invites.preview',
    RPC.roomInvitePreview,
    ['token'],
    'RoomInvitePreviewDto',
    RoomInvitePreviewDtoSchema,
  ),
  roomsToken: route(
    'rooms.token',
    'POST',
    ROUTE_TEMPLATES.roomToken,
    ['id'],
    'required',
    'RoomTokenDto',
    RoomTokenDtoSchema,
    'path parameter (room id); empty JSON body',
  ),
  guestCreateSession: rpc(
    'guest.createSession',
    RPC.guestSessionCreate,
    ['token', 'display_name', 'device_fingerprint_hash', 'media_state'],
    'GuestSessionDto',
    GuestSessionDtoSchema,
    'media_state is sent only when chosen (the RPC defaults to audio)',
  ),
  guestGet: rpc('guest.get', RPC.guestSessionGet, [], 'GuestSessionsDto', GuestSessionsDtoSchema),

  // feed, live
  feedPage: route(
    'feed.page',
    'GET',
    ROUTE_TEMPLATES.feed,
    ['scope', 'cursor', 'area'],
    'optional',
    'FeedPageDto',
    FeedPageDtoSchema,
    'query parameters; Visitors: world',
  ),
  liveList: route(
    'live.list',
    'GET',
    ROUTE_TEMPLATES.live,
    ['scope', 'area'],
    'optional',
    'LiveListDto',
    LiveListDtoSchema,
    'query parameters',
  ),

  // posts
  postsCreate: rpc(
    'posts.create',
    RPC.postCreate,
    [
      'type',
      'text',
      'audience',
      'area_id',
      'place_id',
      'media',
      'reply_policy',
      'reshare_policy',
      'parent_post_id',
      'provenance',
    ],
    'PostViewDto',
    PostCreateResultSchema,
    'media = media object ids, provenance[i] labels media[i]; the client returns the view’s post',
  ),
  postsGet: rpc('posts.get', RPC.postGet, ['post_id'], 'PostDetailDto', PostDetailDtoSchema),
  postsDelete: rpcVoid(
    'posts.delete',
    RPC.postDelete,
    ['post_id'],
    'returns the PostViewDto tombstone',
  ),
  postsReact: rpc(
    'posts.react',
    RPC.postReactionSet,
    ['post_id', 'reaction_type'],
    'PostReactionDto',
    PostReactionDtoSchema,
    'null clears',
  ),
  postsHide: rpcVoid('posts.hide', RPC.postHide, ['post_id'], 'returns { postId, hidden }'),
  postsReplies: rpc(
    'posts.replies',
    RPC.postReplies,
    ['post_id', 'cursor', 'limit'],
    'PostRepliesPageDto',
    PostRepliesResultSchema,
    'cursor is the previous page nextCursor (the last reply id); a bare array is accepted',
  ),
  postsByAuthor: rpc(
    'posts.byAuthor',
    RPC.postsByAuthor,
    ['handle', 'cursor', 'limit'],
    'PostsByAuthorPageDto',
    PostsByAuthorPageDtoSchema,
    'root posts the caller may see, newest first; cursor is the previous page nextCursor',
  ),

  // social, search, safety
  socialProfile: rpc('social.profile', RPC.profileGet, ['handle'], 'ProfileDto', ProfileDtoSchema),
  socialFriendRequest: rpc(
    'social.friendRequest',
    RPC.friendRequestSend,
    ['target_human_id'],
    'RelationshipChangeDto',
    RelationshipChangeDtoSchema,
  ),
  socialAcceptFriend: rpc(
    'social.acceptFriend',
    RPC.friendRequestAccept,
    ['source_human_id'],
    'RelationshipChangeDto',
    RelationshipChangeDtoSchema,
  ),
  socialDeclineFriend: rpc(
    'social.declineFriend',
    RPC.friendRequestDecline,
    ['source_human_id'],
    'RelationshipChangeDto',
    RelationshipChangeDtoSchema,
  ),
  socialRemoveFriend: rpc(
    'social.removeFriend',
    RPC.friendRemove,
    ['other_human_id'],
    'RelationshipChangeDto',
    RelationshipChangeDtoSchema,
  ),
  socialSetFollow: rpc(
    'social.setFollow',
    RPC.followSet,
    ['target_human_id', 'following'],
    'RelationshipChangeDto',
    RelationshipChangeDtoSchema,
  ),
  socialBlock: rpc(
    'social.block',
    RPC.blockSet,
    ['target_human_id', 'blocked'],
    'BlockChangeDto',
    BlockChangeDtoSchema,
    'blocked = true',
  ),
  socialUnblock: rpc(
    'social.unblock',
    RPC.blockSet,
    ['target_human_id', 'blocked'],
    'BlockChangeDto',
    BlockChangeDtoSchema,
    'blocked = false',
  ),
  socialBlocks: rpc(
    'social.blocks',
    RPC.blocksList,
    [],
    'BlocksListDto',
    BlocksResultSchema,
    'a bare array is accepted',
  ),
  searchQuery: rpc(
    'search.query',
    RPC.search,
    ['q', 'limit'],
    'SearchResultsDto',
    SearchResultsDtoSchema,
  ),
  safetyReport: rpc(
    'safety.report',
    RPC.reportCreate,
    ['target_type', 'target_id', 'reason', 'details'],
    'ReportDto',
    ReportDtoSchema,
  ),
  safetyMyReports: rpc(
    'safety.myReports',
    RPC.reportsMine,
    [],
    'ReportDto[]',
    ReportsResultSchema,
    '{ reports } or a bare array is accepted',
  ),

  // notifications, presence
  notificationsList: rpc(
    'notifications.list',
    RPC.notificationsList,
    ['cursor', 'limit'],
    'NotificationsPageDto',
    NotificationsPageDtoSchema,
  ),
  notificationsMarkRead: rpcVoid(
    'notifications.markRead',
    RPC.notificationMarkRead,
    ['id'],
    'returns the notification row without copy',
  ),
  notificationsMarkAllRead: rpcVoid(
    'notifications.markAllRead',
    RPC.notificationsMarkAllRead,
    [],
    'returns { markedCount, unreadCount }',
  ),
  notificationsUnreadCount: rpc(
    'notifications.unreadCount',
    RPC.notificationsUnreadCount,
    [],
    'UnreadCountDto',
    UnreadCountDtoSchema,
    'the client returns the number',
  ),
  notificationsRegisterPushToken: rpcVoid(
    'notifications.registerPushToken',
    RPC.pushTokenRegister,
    ['token', 'platform'],
    'returns { token, platform, updatedAt }',
  ),
  notificationsRemovePushToken: rpcVoid(
    'notifications.removePushToken',
    RPC.pushTokenRemove,
    ['token'],
    'returns { removed }',
  ),
  presencePing: rpcVoid(
    'presence.ping',
    RPC.presencePing,
    ['conversation_id', 'room_id', 'platform'],
    'returns the presence row',
  ),

  // location, places, map
  locationResolveArea: rpc(
    'location.resolveArea',
    RPC.areaResolve,
    ['lat', 'lng'],
    'AreaResolutionDto',
    AreaResolutionDtoSchema,
    'the position is never stored',
  ),
  locationSearchAreas: rpc(
    'location.searchAreas',
    RPC.areasSearch,
    ['q'],
    'AreaDto[]',
    AreasResultSchema,
    '{ areas } or a bare array is accepted',
  ),
  locationGetArea: rpc('location.getArea', RPC.areaGet, ['id'], 'AreaDto', AreaDtoSchema),
  locationSetContext: rpc(
    'location.setContext',
    RPC.contextSet,
    ['current_area_id', 'current_city_id', 'home_city_id'],
    'HumanContextDto',
    HumanContextDtoSchema,
    'only ids, never coordinates',
  ),
  locationResolveAndSetContext: rpc(
    'location.resolveAndSetContext',
    RPC.contextResolveAndSet,
    ['lat', 'lng'],
    'HumanContextDto',
    HumanContextDtoSchema,
    'resolves and stores the area ids in one call; the position is never stored',
  ),
  locationSetScope: rpcVoid(
    'location.setScope',
    RPC.scopeSet,
    ['surface', 'scope'],
    'returns { surface, scope }',
  ),
  locationShare: rpc(
    'location.share',
    RPC.locationShareCreate,
    ['audience_type', 'audience_id', 'precision', 'duration_seconds', 'lat', 'lng'],
    'LocationShareDto',
    LocationShareDtoSchema,
  ),
  locationUpdateShare: rpc(
    'location.updateShare',
    RPC.locationShareUpdate,
    ['share_id', 'lat', 'lng'],
    'LocationShareDto',
    LocationShareDtoSchema,
  ),
  locationRevokeShare: rpc(
    'location.revokeShare',
    RPC.locationShareRevoke,
    ['share_id'],
    'LocationShareDto',
    LocationShareDtoSchema,
  ),
  locationVisibleShares: rpc(
    'location.visibleShares',
    RPC.locationSharesVisible,
    [],
    'MapFriendDto[]',
    SharesResultSchema,
    '{ shares } or a bare array is accepted',
  ),
  locationMyShares: rpc(
    'location.myShares',
    RPC.locationSharesMine,
    [],
    'LocationShareDto[]',
    MySharesResultSchema,
    'the caller’s live shares; { shares } or a bare array is accepted',
  ),
  placesSearch: rpc(
    'places.search',
    RPC.placesSearch,
    ['q', 'area_id'],
    'PlaceDto[]',
    PlacesResultSchema,
    '{ places } or a bare array is accepted',
  ),
  placesGet: rpc('places.get', RPC.placeGet, ['id'], 'PlaceDto', PlaceDtoSchema),
  placesCreate: rpc(
    'places.create',
    RPC.placeCreate,
    ['name', 'lat', 'lng', 'area_id', 'category'],
    'PlaceDto',
    PlaceDtoSchema,
  ),
  mapObjects: rpc(
    'map.objects',
    RPC.mapObjects,
    ['scope', 'min_lat', 'min_lng', 'max_lat', 'max_lng'],
    'MapObjectsDto',
    MapObjectsDtoSchema,
    'bbox [west, south, east, north] → min_lng, min_lat, max_lng, max_lat',
  ),

  // analytics, diagnostics
  analyticsIngest: routeVoid(
    'analytics.ingest',
    'POST',
    ROUTE_TEMPLATES.analyticsIngest,
    ['v', 'sentAt', 'events'],
    'optional',
    'JSON body (AnalyticsIngestBatch)',
  ),
  diagnosticsRtc: routeVoid(
    'diagnostics.rtc',
    'POST',
    ROUTE_TEMPLATES.diagnosticsRtc,
    ['v', 'ts', 'event'],
    'optional',
    'JSON body (RtcDiagnosticEnvelope)',
  ),
} as const satisfies Record<string, CallSpec>

export type CallKey = keyof typeof CALLS

// ---------------------------------------------------------------------------
// The manifest
// ---------------------------------------------------------------------------

/** One client method as the manifest describes it (no schema, JSON-serializable). */
export interface RpcManifestEntry {
  readonly method: string
  readonly kind: CallKind
  /** `public.<name>` when the method calls an RPC, else `null`. */
  readonly rpc: string | null
  /** `<METHOD> <path template>` when the method calls a server route, else `null`. */
  readonly route: string | null
  readonly args: readonly string[]
  readonly result: string
  /** Direct table/view access (`kind: 'table'`). */
  readonly table?: string
  /** Methods this one is built on (`kind: 'composite'`). */
  readonly via?: readonly string[]
  readonly notes?: string
}

export function manifestEntry(spec: CallSpec): RpcManifestEntry {
  const base = {
    method: spec.method,
    kind: spec.kind,
    rpc: spec.kind === 'rpc' ? spec.rpc : null,
    route: spec.kind === 'route' ? `${spec.httpMethod} ${spec.path}` : null,
    args: spec.args,
    result: spec.result,
  }
  const entry: RpcManifestEntry = {
    ...base,
    ...(spec.kind === 'table' ? { table: spec.table } : {}),
    ...(spec.kind === 'composite' ? { via: spec.via } : {}),
    ...(spec.notes === undefined ? {} : { notes: spec.notes }),
  }
  return entry
}

/** Every client method → RPC / route / table / composite, in ARCHITECTURE §7 order. */
export const RPC_MANIFEST: readonly RpcManifestEntry[] = Object.values(CALLS).map(manifestEntry)

/** The RPC names the client calls (each once, whatever the number of methods behind it). */
export const MANIFEST_RPC_NAMES: readonly string[] = [
  ...new Set(RPC_MANIFEST.flatMap((entry) => (entry.rpc === null ? [] : [entry.rpc]))),
]
