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
  mapObjects: 'map_objects',
  // §6 Notifications
  notificationsList: 'notifications_list',
  notificationMarkRead: 'notification_mark_read',
  notificationsMarkAllRead: 'notifications_mark_all_read',
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

/** Server-tier routes (ARCHITECTURE §6), relative to `serverBaseUrl`. */
export const SERVER_ROUTES = {
  roomToken: (roomId: string): string => `/api/rooms/${encodeURIComponent(roomId)}/token`,
  claimVerificationStart: '/api/claim/verification/start',
  claimVerificationResult: (sessionId: string): string =>
    `/api/claim/verification/${encodeURIComponent(sessionId)}`,
  feed: '/api/feed',
  live: '/api/live',
  analyticsIngest: '/api/analytics/ingest',
  diagnosticsRtc: '/api/diagnostics/rtc',
} as const

/** Query parameter names of `GET /api/feed` and `GET /api/live`. */
export const SERVER_QUERY = {
  scope: 'scope',
  cursor: 'cursor',
  area: 'area',
} as const
