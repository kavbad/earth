/**
 * Inputs of the permissions mirror (ARCHITECTURE §1 "rule-home table": the one deliberate double
 * implementation). The database enforces; these types describe what a caller must already know
 * about the viewer and the object to predict the database's answer.
 *
 * Every field is a fact the database derives itself (`earth.current_role_kind()`,
 * `earth.relation_to`, `earth.is_blocked_either`, `earth.is_group_member`, participant rows,
 * `human_context` area containment). The mirror never infers one from another: a caller who does
 * not know a fact leaves it out and the mirror fails closed.
 *
 * Schemas are zod so the shared fixtures (`packages/permissions/fixtures/*.json`, DB_API §11) are
 * validated the same way by this package and by `supabase/tests`.
 */
import {
  AudienceSchema,
  ConversationTypeSchema,
  EARTH_ERROR_CODES,
  HumanStatusSchema,
  MediaStateSchema,
  ProfileVisibilitySchema,
  RoleKindSchema,
  RoomJoinPolicySchema,
  RoomStatusSchema,
  RoomVisibilitySchema,
  ViewerRelationSchema,
  isFlagEnabled,
  type EarthErrorCode,
  type FlagsDto,
} from '@earth/domain'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

/**
 * Who is looking (ARCHITECTURE §4 four states + `service`) and what the database knows about
 * their relation to the object. Booleans default to `false`, `relationToAuthor` to `'other'`.
 */
export const ViewerSchema = z.object({
  /** `earth.current_role_kind()`. Guests, claiming Humans and visitors have no social graph. */
  kind: RoleKindSchema,
  /** The active Human id for `kind: 'human'`; informational (the mirror never compares ids). */
  humanId: z.string().min(1).optional(),
  /** `earth.relation_to(viewer, author)` for the object's author / owner / target Human. */
  relationToAuthor: ViewerRelationSchema.optional(),
  /** `earth.shared_group_count(viewer, author)`; informational for ranking, not permission. */
  sharedGroups: z.int().min(0).optional(),
  /**
   * `earth.is_blocked_either(viewer, other)`: for posts/profiles/invite previews the other Human is
   * the author; for rooms any consenting audio/camera Human participant; for direct conversations
   * the other member; for a Guest a room-level block of their session or device.
   */
  blockedEitherWay: z.boolean(),
  /** Active member of the group the object belongs to (group rooms, group conversations). */
  isGroupMember: z.boolean().optional(),
  /** `conversation_members` row for the conversation. */
  isConversationMember: z.boolean().optional(),
  /**
   * A live seat in the room: `room_participants.status in ('invited', 'waiting', 'active')` for a
   * Human, an unexpired `guest_sessions` row for a Guest.
   */
  isInvitedParticipant: z.boolean().optional(),
  /** Arrived through an unexpired, unrevoked room invite token (`room_invite_join`, `/live/:token`). */
  hasLink: z.boolean().optional(),
  /** Friend of at least one active audio/camera Human whose consent covers the room's visibility (spec §58). */
  isFriendOfConsentingParticipant: z.boolean().optional(),
  /** Friend of a friend of such a participant (`extended` visibility, `friends_of_friends` policy). */
  isFriendOfFriendOfConsentingParticipant: z.boolean().optional(),
  /**
   * The viewer's current area context (`human_context.current_area_id` / `current_city_id`) lies
   * inside the object's `area_id` (`earth.area_contains`). Implies `sameCity`.
   */
  sameNeighborhood: z.boolean().optional(),
  /** The viewer's current or home city equals the object's city (the area or its city ancestor). */
  sameCity: z.boolean().optional(),
})
export type Viewer = z.infer<typeof ViewerSchema>

// ---------------------------------------------------------------------------
// Flags (ARCHITECTURE §12) — only the keys the permission rules read
// ---------------------------------------------------------------------------

export const PermissionFlagsSchema = z.object({
  /** `PUBLIC_WORLD_ENABLED`: visitors may read World posts. */
  publicWorldEnabled: z.boolean(),
  /** `PUBLIC_LIVE_ENABLED`: visitors may see World Lives. */
  publicLiveEnabled: z.boolean(),
  /** `GUEST_ROOMS_ENABLED`: Guests may create a session from a room link. */
  guestRoomsEnabled: z.boolean(),
})
export type PermissionFlags = z.infer<typeof PermissionFlagsSchema>

/** Launch defaults (ARCHITECTURE §12, migration 0006). */
export const DEFAULT_PERMISSION_FLAGS: PermissionFlags = Object.freeze({
  publicWorldEnabled: true,
  publicLiveEnabled: true,
  guestRoomsEnabled: true,
})

/** Feature flag keys the permission rules depend on (canonical key list: `@earth/config`). */
export const PERMISSION_FLAG_KEYS = {
  publicWorldEnabled: 'PUBLIC_WORLD_ENABLED',
  publicLiveEnabled: 'PUBLIC_LIVE_ENABLED',
  guestRoomsEnabled: 'GUEST_ROOMS_ENABLED',
} as const satisfies Record<keyof PermissionFlags, string>

/** Projects a `feature_flags` read (`FlagsDto`, missing = disabled) onto the permission flags. */
export function permissionFlagsFrom(flags: FlagsDto): PermissionFlags {
  return {
    publicWorldEnabled: isFlagEnabled(flags, PERMISSION_FLAG_KEYS.publicWorldEnabled),
    publicLiveEnabled: isFlagEnabled(flags, PERMISSION_FLAG_KEYS.publicLiveEnabled),
    guestRoomsEnabled: isFlagEnabled(flags, PERMISSION_FLAG_KEYS.guestRoomsEnabled),
  }
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

/**
 * `posts.status` (DB_API §4: `'active' | 'removed'`). Not a Postgres enum type, so it is not in
 * `ENUM_REGISTRY`; it lives here until `@earth/domain` names it.
 */
export const POST_STATUSES = ['active', 'removed'] as const
export type PostStatus = (typeof POST_STATUSES)[number]
export const PostStatusSchema = z.enum(POST_STATUSES)

/** What `earth.can_view_post` reads from the post (spec §29, §31). */
export const PostVisibilityInputSchema = z.object({
  audience: AudienceSchema,
  status: PostStatusSchema,
  isReply: z.boolean(),
  /** The root post's audience for replies (spec §72: replies never widen). Falls back to `audience`. */
  rootAudience: AudienceSchema.optional(),
  /** `post_hides` row by the viewer — a feed concern, never a direct-fetch denial (DB_API §4). */
  hiddenByViewer: z.boolean().optional(),
})
export type PostVisibilityInput = z.infer<typeof PostVisibilityInputSchema>

/** What `earth.room_visible_to` reads from the room (spec §32; DB_API §3). */
export const RoomViewInputSchema = z.object({
  visibility: RoomVisibilitySchema,
  /** Defaults to `active`. Only `starting` / `active` rooms are discoverable beyond their context. */
  status: RoomStatusSchema.optional(),
  guestsDisabled: z.boolean(),
})
export type RoomViewInput = z.infer<typeof RoomViewInputSchema>

/** What `room_join` reads from the room. */
export const RoomJoinInputSchema = RoomViewInputSchema.extend({
  joinPolicy: RoomJoinPolicySchema,
})
export type RoomJoinInput = z.infer<typeof RoomJoinInputSchema>

/** The join the viewer attempts (`room_join(room_id, media_state, consent_level)`). */
export const JoinAttemptSchema = z.object({
  mediaState: MediaStateSchema,
  /** The consent the viewer offers; `invited` when they have not consented to anything wider. */
  consentLevel: RoomVisibilitySchema,
})
export type JoinAttempt = z.infer<typeof JoinAttemptSchema>

/** What `earth.identity_visible_to` reads from the target (spec §16, §17). */
export const ProfileVisibilityInputSchema = z.object({
  profileVisibility: ProfileVisibilitySchema,
  humanStatus: HumanStatusSchema,
})
export type ProfileVisibilityInput = z.infer<typeof ProfileVisibilityInputSchema>

/** What `earth.can_view_conversation` / `message_send` read from the conversation (spec §25, §56). */
export const ConversationInputSchema = z.object({
  conversationType: ConversationTypeSchema,
})
export type ConversationInput = z.infer<typeof ConversationInputSchema>

/** One candidate sample member of `group_invite_preview` (spec §24, §46; DB_API §2). */
export const InviteMemberInputSchema = z.object({
  profileVisibility: ProfileVisibilitySchema,
  /** `earth.are_friends(viewer, member)`. */
  isFriendOfViewer: z.boolean(),
  /** Defaults to `active`; only active Humans are sampled. */
  humanStatus: HumanStatusSchema.optional(),
})
export type InviteMemberInput = z.infer<typeof InviteMemberInputSchema>

// ---------------------------------------------------------------------------
// canViewObject dispatch
// ---------------------------------------------------------------------------

/** Object kinds covered by the shared fixtures (DB_API §11). */
export const VIEWABLE_OBJECT_TYPES = [
  'post',
  'room',
  'profile',
  'conversation',
  'group_invite_preview',
] as const
export type ViewableObjectType = (typeof VIEWABLE_OBJECT_TYPES)[number]
export const ViewableObjectTypeSchema = z.enum(VIEWABLE_OBJECT_TYPES)

export const ViewableObjectSchema = z.discriminatedUnion('type', [
  PostVisibilityInputSchema.extend({ type: z.literal('post') }),
  RoomViewInputSchema.extend({
    type: z.literal('room'),
    /** Carried by room fixtures for the join probe; viewing ignores it. */
    joinPolicy: RoomJoinPolicySchema.optional(),
  }),
  ProfileVisibilityInputSchema.extend({ type: z.literal('profile') }),
  ConversationInputSchema.extend({ type: z.literal('conversation') }),
  InviteMemberInputSchema.extend({ type: z.literal('group_invite_preview') }),
])
export type ViewableObject = z.infer<typeof ViewableObjectSchema>

export interface CanViewObjectInput {
  readonly viewer: Viewer
  readonly object: ViewableObject
  /** Defaults to the launch defaults. */
  readonly flags?: PermissionFlags
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export const EarthErrorCodeSchema = z.enum(EARTH_ERROR_CODES)

/** Outcome of a mutation-shaped check: the RPC would succeed, or raise `reason`. */
export interface PermissionDecision {
  readonly allowed: boolean
  /** The `earth.raise(...)` code the RPC would use; present only when `allowed` is `false`. */
  readonly reason?: EarthErrorCode
  /** `request` join policy: the RPC succeeds but seats the viewer as `waiting` for a moderator. */
  readonly requiresApproval?: boolean
}

export function allow(requiresApproval = false): PermissionDecision {
  return requiresApproval ? { allowed: true, requiresApproval: true } : { allowed: true }
}

export function deny(reason: EarthErrorCode): PermissionDecision {
  return { allowed: false, reason }
}

/** The code `earth.assert_human()` raises for a caller that is not an active Human, or `null`. */
export function assertHumanFailure(kind: Viewer['kind']): EarthErrorCode | null {
  switch (kind) {
    case 'visitor':
      return 'not_authenticated'
    case 'guest':
    case 'claiming':
    case 'service':
      return 'not_a_human'
    case 'human':
      return null
  }
}
