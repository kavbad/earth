import { z } from 'zod'

import { isJoinPolicyAllowedFor } from '../audience'
import { GUEST_DISPLAY_NAME_MAX } from '../constants'
import { EARTH_ERROR_CODES } from '../errors'
import {
  AreaPrecisionSchema,
  MediaStateSchema,
  ParticipantRoleSchema,
  ParticipantStatusSchema,
  RoomContextTypeSchema,
  RoomJoinPolicySchema,
  RoomStatusSchema,
  RoomVisibilitySchema,
  ViewerRelationSchema,
} from '../enums'
import {
  AreaIdSchema,
  GuestSessionIdSchema,
  HumanIdSchema,
  MediaIdentitySchema,
  PlaceIdSchema,
  RoomIdSchema,
} from '../ids'
import { DisplayNameSchema } from './claim'
import { IsoDateTimeSchema, NullableUrlSchema, PositiveIntSchema, UrlSchema } from './common'

export const GuestDisplayNameSchema = z.string().trim().min(1).max(GUEST_DISPLAY_NAME_MAX)

/** `room_participants` (spec §33) as seen by the viewer. Exactly one of humanId / guestSessionId. */
export const RoomParticipantDtoSchema = z
  .object({
    id: z.uuid(),
    humanId: HumanIdSchema.nullable(),
    guestSessionId: GuestSessionIdSchema.nullable(),
    displayName: DisplayNameSchema,
    avatarUrl: NullableUrlSchema,
    isGuest: z.boolean(),
    role: ParticipantRoleSchema,
    mediaState: MediaStateSchema,
    status: ParticipantStatusSchema,
    audienceConsentLevel: RoomVisibilitySchema,
    joinedAt: IsoDateTimeSchema,
    /** `null` for visitors/guests who have no social graph. */
    relationToViewer: ViewerRelationSchema.nullable(),
  })
  .refine(
    (p) =>
      (p.humanId === null) !== (p.guestSessionId === null) &&
      p.isGuest === (p.guestSessionId !== null),
    { message: 'exactly one of humanId or guestSessionId, matching isGuest' },
  )
export type RoomParticipantDto = z.infer<typeof RoomParticipantDtoSchema>

/** `rooms` (spec §32) plus consent state, participants and the viewer's own participant row. */
export const RoomDtoSchema = z.object({
  id: RoomIdSchema,
  contextType: RoomContextTypeSchema,
  contextId: z.uuid().nullable(),
  initiatedByHumanId: HumanIdSchema,
  visibility: RoomVisibilitySchema,
  joinPolicy: RoomJoinPolicySchema,
  status: RoomStatusSchema,
  areaPrecision: AreaPrecisionSchema,
  areaId: AreaIdSchema.nullable(),
  placeId: PlaceIdSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  startedAt: IsoDateTimeSchema.nullable(),
  endedAt: IsoDateTimeSchema.nullable(),
  /** Requested wider visibility awaiting participant consent (ARCHITECTURE §10). */
  pendingVisibility: RoomVisibilitySchema.nullable(),
  participants: z.array(RoomParticipantDtoSchema),
  myParticipant: RoomParticipantDtoSchema.nullable(),
  /** "Weekend Crew" / "Xavier + Kavon" (SCREEN 14 top). */
  contextTitle: z.string().nullable(),
  guestsDisabled: z.boolean(),
  /**
   * Join affordances for the viewer (0996 `earth.room_join_check`, the check `room_join` runs):
   * whether audio / camera would be admitted — the consent sheet aside — and the code the RPC
   * would raise otherwise (`null` when the viewer may join). Absent from older servers.
   */
  canJoinAudio: z.boolean().optional(),
  canJoinCamera: z.boolean().optional(),
  joinReason: z.enum(EARTH_ERROR_CODES).nullable().optional(),
})
export type RoomDto = z.infer<typeof RoomDtoSchema>

/** `room_start`: existing active room for the context, or a new one. */
export const RoomStartDtoSchema = z.object({
  room: RoomDtoSchema,
  created: z.boolean(),
})
export type RoomStartDto = z.infer<typeof RoomStartDtoSchema>

/** `room_set_visibility` / `room_consent` / `room_set_media_state` outcome. */
export const RoomVisibilityChangeDtoSchema = z.object({
  applied: z.boolean(),
  visibility: RoomVisibilitySchema,
  pendingVisibility: RoomVisibilitySchema.nullable(),
  /** `room_participants.id` of Humans whose consent is still required. */
  pendingParticipantIds: z.array(z.uuid()),
})
export type RoomVisibilityChangeDto = z.infer<typeof RoomVisibilityChangeDtoSchema>

/**
 * `room_leave` (DB_API §3; spec §61): when the leaver was the sole moderator, the Human the room was
 * handed to (they see "You're keeping the room open."); `null` when no transfer happened.
 */
export const RoomLeaveDtoSchema = z.object({
  transferredTo: HumanIdSchema.nullable(),
})
export type RoomLeaveDto = z.infer<typeof RoomLeaveDtoSchema>

export const RoomInviteParticipantDtoSchema = z.object({
  displayName: DisplayNameSchema,
  avatarUrl: NullableUrlSchema,
  isGuest: z.boolean(),
})
export type RoomInviteParticipantDto = z.infer<typeof RoomInviteParticipantDtoSchema>

/** SCREEN 17: what a link opens to before anyone signs in. */
export const RoomInvitePreviewDtoSchema = z.object({
  roomId: RoomIdSchema,
  contextTitle: z.string().nullable(),
  visibility: RoomVisibilitySchema,
  joinPolicy: RoomJoinPolicySchema,
  participants: z.array(RoomInviteParticipantDtoSchema),
  invitedByDisplayName: DisplayNameSchema.nullable(),
  guestsAllowed: z.boolean(),
  ended: z.boolean(),
})
export type RoomInvitePreviewDto = z.infer<typeof RoomInvitePreviewDtoSchema>

export const RoomInviteCreateDtoSchema = z.object({
  token: z.string().min(1),
  url: UrlSchema,
  expiresAt: IsoDateTimeSchema,
})
export type RoomInviteCreateDto = z.infer<typeof RoomInviteCreateDtoSchema>

/** `guest_session_create` (spec §34). The guest has no persistent global identity. */
export const GuestSessionDtoSchema = z.object({
  guestSessionId: GuestSessionIdSchema,
  roomId: RoomIdSchema,
  displayName: GuestDisplayNameSchema,
  expiresAt: IsoDateTimeSchema,
})
export type GuestSessionDto = z.infer<typeof GuestSessionDtoSchema>

/**
 * `room_media_grant(room_id)` (ARCHITECTURE §10). The token route never adds permissions beyond
 * the grant. Keys are the camelCase of §10's `livekit_room`, `identity`, `name`, `role`,
 * `can_publish`, `can_subscribe`, `can_publish_data`, `ttl_seconds`.
 */
export const MediaGrantDtoSchema = z.object({
  livekitRoom: RoomIdSchema,
  identity: MediaIdentitySchema,
  name: z.string().min(1),
  role: ParticipantRoleSchema,
  canPublish: z.boolean(),
  canSubscribe: z.boolean(),
  canPublishData: z.boolean(),
  ttlSeconds: PositiveIntSchema,
})
export type MediaGrantDto = z.infer<typeof MediaGrantDtoSchema>

/** `POST /api/rooms/:id/token` result. */
export const RoomTokenDtoSchema = z.object({
  token: z.string().min(1),
  url: z.url({ protocol: /^(wss?|https?)$/ }),
  identity: MediaIdentitySchema,
  expiresAt: IsoDateTimeSchema,
})
export type RoomTokenDto = z.infer<typeof RoomTokenDtoSchema>

export const RoomStartInputSchema = z
  .object({
    contextType: RoomContextTypeSchema,
    contextId: z.uuid().nullable(),
  })
  .refine((input) => input.contextType === 'standalone' || input.contextId !== null, {
    message: 'contextId is required unless contextType is standalone',
    path: ['contextId'],
  })
export type RoomStartInput = z.infer<typeof RoomStartInputSchema>

/** `room_join(room_id, media_state, consent_level)`; consent must cover the room's visibility for audio/camera. */
export const RoomJoinInputSchema = z.object({
  roomId: RoomIdSchema,
  mediaState: MediaStateSchema,
  consentLevel: RoomVisibilitySchema,
})
export type RoomJoinInput = z.infer<typeof RoomJoinInputSchema>

export const RoomSetMediaStateInputSchema = z.object({
  roomId: RoomIdSchema,
  mediaState: MediaStateSchema,
})
export type RoomSetMediaStateInput = z.infer<typeof RoomSetMediaStateInputSchema>

export const RoomConsentInputSchema = z.object({
  roomId: RoomIdSchema,
  level: RoomVisibilitySchema,
})
export type RoomConsentInput = z.infer<typeof RoomConsentInputSchema>

/** SCREEN 15: visibility + a join policy the UI offers for it. */
export const RoomSetVisibilityInputSchema = z
  .object({
    roomId: RoomIdSchema,
    visibility: RoomVisibilitySchema,
    joinPolicy: RoomJoinPolicySchema,
  })
  .refine((input) => isJoinPolicyAllowedFor(input.visibility, input.joinPolicy), {
    message: 'join policy is not offered for this visibility',
    path: ['joinPolicy'],
  })
export type RoomSetVisibilityInput = z.infer<typeof RoomSetVisibilityInputSchema>

export const RoomSetJoinPolicyInputSchema = z.object({
  roomId: RoomIdSchema,
  joinPolicy: RoomJoinPolicySchema,
})
export type RoomSetJoinPolicyInput = z.infer<typeof RoomSetJoinPolicyInputSchema>

export const RoomRemoveParticipantInputSchema = z.object({
  roomId: RoomIdSchema,
  participantId: z.uuid(),
})
export type RoomRemoveParticipantInput = z.infer<typeof RoomRemoveParticipantInputSchema>

export const RoomInviteCreateInputSchema = z.object({
  roomId: RoomIdSchema,
  joinPolicyOverride: RoomJoinPolicySchema.nullish(),
  expiresInMinutes: PositiveIntSchema.max(24 * 60).nullish(),
})
export type RoomInviteCreateInput = z.infer<typeof RoomInviteCreateInputSchema>

export const GuestSessionCreateInputSchema = z.object({
  inviteToken: z.string().min(1),
  displayName: GuestDisplayNameSchema,
})
export type GuestSessionCreateInput = z.infer<typeof GuestSessionCreateInputSchema>

/** Count of participants that are visibly in the room (active, not merely invited/waiting). */
export function activeParticipantCount(room: Pick<RoomDto, 'participants'>): number {
  return room.participants.filter((p) => p.status === 'active').length
}
