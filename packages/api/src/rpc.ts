/**
 * Every RPC name (DB_API.md), direct-read table/view, storage bucket and server route the client
 * touches, as constants — no method spells a database or route name as a string literal.
 */

/** `public.<noun>_<verb>` RPC names, grouped as in DB_API.md. */
export const RPC = {
  // §1 Identity
  meGet: 'me_get',
  claimStart: 'claim_start',
  claimGet: 'claim_get',
  claimSetIdentity: 'claim_set_identity',
  claimVerificationBegin: 'claim_verification_begin',
  claimComplete: 'claim_complete',
  identityReviewCreate: 'identity_review_create',
  profileGet: 'profile_get',
  identityUpdate: 'identity_update',
  handleAvailable: 'handle_available',
  friendRequestSend: 'friend_request_send',
  friendRequestAccept: 'friend_request_accept',
  friendRequestDecline: 'friend_request_decline',
  friendRemove: 'friend_remove',
  followSet: 'follow_set',
  blockSet: 'block_set',
  presencePing: 'presence_ping',
  contextSet: 'context_set',
  contextResolveAndSet: 'context_resolve_and_set',
  scopeSet: 'scope_set',
  pushTokenRegister: 'push_token_register',
  pushTokenRemove: 'push_token_remove',
  // §2 Groups and conversations
  groupCreate: 'group_create',
  groupGet: 'group_get',
  groupUpdate: 'group_update',
  groupInviteCreate: 'group_invite_create',
  groupInviteRevoke: 'group_invite_revoke',
  groupInvitePreview: 'group_invite_preview',
  groupInviteJoin: 'group_invite_join',
  groupLeave: 'group_leave',
  groupMemberRemove: 'group_member_remove',
  groupMemberSetRole: 'group_member_set_role',
  conversationDirectGetOrCreate: 'conversation_direct_get_or_create',
  conversationGroupCreate: 'conversation_group_create',
  conversationsList: 'conversations_list',
  conversationGet: 'conversation_get',
  messagesList: 'messages_list',
  messagesSince: 'messages_since',
  messageSend: 'message_send',
  messageEdit: 'message_edit',
  messageDelete: 'message_delete',
  messageReactionToggle: 'message_reaction_toggle',
  conversationMarkRead: 'conversation_mark_read',
  conversationSetPrefs: 'conversation_set_prefs',
  conversationReadReceipts: 'conversation_read_receipts',
  // §3 Rooms, guests, live
  roomStart: 'room_start',
  roomGet: 'room_get',
  roomJoin: 'room_join',
  roomInviteJoin: 'room_invite_join',
  roomSetMediaState: 'room_set_media_state',
  roomConsent: 'room_consent',
  roomSetVisibility: 'room_set_visibility',
  roomSetJoinPolicy: 'room_set_join_policy',
  roomSetGuestsDisabled: 'room_set_guests_disabled',
  roomAdmit: 'room_admit',
  roomLeave: 'room_leave',
  roomEnd: 'room_end',
  roomRemoveParticipant: 'room_remove_participant',
  roomInviteCreate: 'room_invite_create',
  roomInvitePreview: 'room_invite_preview',
  guestSessionCreate: 'guest_session_create',
  guestSessionGet: 'guest_session_get',
  // §4 Posts
  postCreate: 'post_create',
  postGet: 'post_get',
  postDelete: 'post_delete',
  postReactionSet: 'post_reaction_set',
  postHide: 'post_hide',
  postReplies: 'post_replies',
  postsByAuthor: 'posts_by_author',
  // §5 Areas, places, location, map
  areaResolve: 'area_resolve',
  areasSearch: 'areas_search',
  areaGet: 'area_get',
  placesSearch: 'places_search',
  placeGet: 'place_get',
  placeCreate: 'place_create',
  locationShareCreate: 'location_share_create',
  locationShareUpdate: 'location_share_update',
  locationShareRevoke: 'location_share_revoke',
  locationSharesVisible: 'location_shares_visible',
  locationSharesMine: 'location_shares_mine',
  mapObjects: 'map_objects',
  // §6 Notifications
  notificationsList: 'notifications_list',
  notificationMarkRead: 'notification_mark_read',
  notificationsMarkAllRead: 'notifications_mark_all_read',
  notificationsUnreadCount: 'notifications_unread_count',
  // §7 Safety
  reportCreate: 'report_create',
  reportsMine: 'reports_mine',
  blocksList: 'blocks_list',
  // §9 Search
  search: 'search',
} as const

export type RpcName = (typeof RPC)[keyof typeof RPC]

/** Tables/views read directly (RLS-governed selects, DB_API §1/§2/§8) and the one direct insert. */
export const TABLES = {
  featureFlags: 'feature_flags',
  appSettings: 'app_settings',
  groupInvitesView: 'group_invites_view',
  mediaObjects: 'media_objects',
} as const

export type TableName = (typeof TABLES)[keyof typeof TABLES]

/** Storage buckets (ARCHITECTURE §5). */
export const STORAGE_BUCKETS = {
  avatars: 'avatars',
  media: 'media',
  voice: 'voice',
} as const

export type StorageBucket = (typeof STORAGE_BUCKETS)[keyof typeof STORAGE_BUCKETS]

/**
 * RPCs that exist in `public` but have no client method by design (ARCHITECTURE §6): reached
 * through their `/api/*` route, by the server tier as the caller, or by cron. Listed so the parity
 * test can tell "server-only" from "forgotten".
 */
export const SERVER_TIER_RPCS = [
  'analytics_track',
  'feed_candidates',
  'human_delete_request',
  'human_pass_record_result',
  'live_candidates',
  'metrics_compute_daily',
  'notifications_mark_pushed',
  'notifications_prune',
  'notifications_unsent',
  'public_feed',
  'report_resolve',
  'room_media_grant',
  'room_participant_sync',
  'rooms_sweep',
  'rtc_diagnostic_record',
] as const

/** Server-tier route templates (ARCHITECTURE §6); `:name` segments are filled by `fillRoute`. */
export const ROUTE_TEMPLATES = {
  roomToken: '/api/rooms/:id/token',
  claimVerificationStart: '/api/claim/verification/start',
  claimVerificationResult: '/api/claim/verification/:sessionId',
  feed: '/api/feed',
  live: '/api/live',
  analyticsIngest: '/api/analytics/ingest',
  diagnosticsRtc: '/api/diagnostics/rtc',
  accountDelete: '/api/account/delete',
} as const

export type RouteTemplate = (typeof ROUTE_TEMPLATES)[keyof typeof ROUTE_TEMPLATES]

const ROUTE_PARAMETER = /:([A-Za-z_][A-Za-z0-9_]*)/g

/** Fills the `:name` parameters of a template (URL-encoded); a missing parameter is a bug. */
export function fillRoute(template: string, params: Readonly<Record<string, string>> = {}): string {
  return template.replace(ROUTE_PARAMETER, (_match, name: string) => {
    const value = params[name]
    if (value === undefined) throw new Error(`route ${template}: missing parameter ${name}`)
    return encodeURIComponent(value)
  })
}

/** Server-tier routes (ARCHITECTURE §6), relative to `serverBaseUrl`. */
export const SERVER_ROUTES = {
  roomToken: (roomId: string): string => fillRoute(ROUTE_TEMPLATES.roomToken, { id: roomId }),
  claimVerificationStart: ROUTE_TEMPLATES.claimVerificationStart,
  claimVerificationResult: (sessionId: string): string =>
    fillRoute(ROUTE_TEMPLATES.claimVerificationResult, { sessionId }),
  feed: ROUTE_TEMPLATES.feed,
  live: ROUTE_TEMPLATES.live,
  analyticsIngest: ROUTE_TEMPLATES.analyticsIngest,
  diagnosticsRtc: ROUTE_TEMPLATES.diagnosticsRtc,
  accountDelete: ROUTE_TEMPLATES.accountDelete,
} as const

/** Query parameter names of `GET /api/feed` and `GET /api/live`. */
export const SERVER_QUERY = {
  scope: 'scope',
  cursor: 'cursor',
  area: 'area',
} as const
