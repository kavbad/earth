/**
 * `rooms` and `guest` (DB_API §3; ARCHITECTURE §10; spec PART VIII).
 */
import {
  type GuestSessionDto,
  GuestSessionDtoSchema,
  type RoomConsentInput,
  RoomConsentInputSchema,
  type RoomDto,
  RoomDtoSchema,
  type RoomId,
  RoomIdSchema,
  type RoomInviteCreateDto,
  RoomInviteCreateDtoSchema,
  type RoomInviteCreateInput,
  RoomInviteCreateInputSchema,
  type RoomInvitePreviewDto,
  RoomInvitePreviewDtoSchema,
  type RoomJoinInput,
  RoomJoinInputSchema,
  type RoomLeaveDto,
  RoomLeaveDtoSchema,
  type RoomSetJoinPolicyInput,
  RoomSetJoinPolicyInputSchema,
  type RoomSetVisibilityInput,
  RoomSetVisibilityInputSchema,
  type RoomStartDto,
  RoomStartDtoSchema,
  type RoomTokenDto,
  RoomTokenDtoSchema,
  type RoomVisibilityChangeDto,
  RoomVisibilityChangeDtoSchema,
} from '@earth/domain'
import { z } from 'zod'

import {
  type GuestSessionCreateArgs,
  GuestSessionCreateArgsSchema,
  type GuestSessionsDto,
  GuestSessionsDtoSchema,
  type RoomAdmitInput,
  RoomAdmitInputSchema,
  type RoomEndInput,
  RoomEndInputSchema,
  type RoomGuestsDisabledInput,
  RoomGuestsDisabledInputSchema,
  type RoomInviteJoinInput,
  RoomInviteJoinInputSchema,
  type RoomRemoveParticipantArgs,
  RoomRemoveParticipantArgsSchema,
  type RoomSetMediaStateArgs,
  RoomSetMediaStateArgsSchema,
  type RoomStartArgs,
  RoomStartArgsSchema,
} from '../dto'
import { RPC, SERVER_ROUTES } from '../rpc'
import { type Transport, parseInput } from '../transport'

export interface RoomInvitesNamespace {
  /** `room_invite_create(room_id, expires_in_seconds, join_policy_override)`; token returned once. */
  create(input: RoomInviteCreateInput): Promise<RoomInviteCreateDto>
  /** `room_invite_preview(token)` — what a link opens to before anyone signs in (SCREEN 17). */
  preview(token: string): Promise<RoomInvitePreviewDto>
}

export interface RoomsNamespace {
  /** `room_start(context_type, context_id, title)`: the existing active room for the context, or a new one. */
  start(input: RoomStartArgs): Promise<RoomStartDto>
  /** `room_get(room_id)`. */
  get(roomId: RoomId): Promise<RoomDto>
  /** `room_join(room_id, media_state, consent_level)`; `consent_required` when consent < visibility for audio/camera. */
  join(input: RoomJoinInput): Promise<RoomDto>
  /** `room_invite_join(token, media_state, consent_level)`: join with link privilege. */
  joinWithInvite(input: RoomInviteJoinInput): Promise<RoomDto>
  /** `room_set_media_state(room_id, media_state, consent_level)`. */
  setMediaState(input: RoomSetMediaStateArgs): Promise<RoomVisibilityChangeDto>
  /** `room_consent(room_id, level)`. */
  consent(input: RoomConsentInput): Promise<RoomVisibilityChangeDto>
  /** `room_set_visibility(room_id, visibility, join_policy)` (moderator). */
  setVisibility(input: RoomSetVisibilityInput): Promise<RoomVisibilityChangeDto>
  /** `room_set_join_policy(room_id, join_policy)` (moderator). */
  setJoinPolicy(input: RoomSetJoinPolicyInput): Promise<void>
  /** `room_set_guests_disabled(room_id, disabled)` (moderator). */
  setGuestsDisabled(input: RoomGuestsDisabledInput): Promise<void>
  /** `room_admit(room_id, participant_id)`: `waiting` → `active`. */
  admit(input: RoomAdmitInput): Promise<void>
  /** `room_leave(room_id)`; `transferredTo` names the new moderator when the leaver held the room. */
  leave(roomId: RoomId): Promise<RoomLeaveDto>
  /** `room_end(room_id, reason)` (moderator). */
  end(input: RoomEndInput): Promise<void>
  /** `room_remove_participant(room_id, participant_id, block_from_room)` (moderator). */
  removeParticipant(input: RoomRemoveParticipantArgs): Promise<void>
  readonly invites: RoomInvitesNamespace
  /** `POST /api/rooms/:id/token`: LiveKit token minted from `room_media_grant`. */
  token(roomId: RoomId): Promise<RoomTokenDto>
}

export interface GuestNamespace {
  /** `guest_session_create(token, display_name, device_fingerprint_hash[, media_state])` as an anonymous auth user. */
  createSession(input: GuestSessionCreateArgs): Promise<GuestSessionDto>
  /** `guest_session_get()`: own sessions and the "You've joined N rooms" counts. */
  get(): Promise<GuestSessionsDto>
}

const TokenSchema = z.string().min(1)
const SECONDS_PER_MINUTE = 60

export function createRoomsNamespace(transport: Transport): RoomsNamespace {
  const invites: RoomInvitesNamespace = {
    create(input) {
      const parsed = parseInput(RoomInviteCreateInputSchema, input)
      return transport.rpc(
        RPC.roomInviteCreate,
        {
          room_id: parsed.roomId,
          expires_in_seconds:
            parsed.expiresInMinutes === null || parsed.expiresInMinutes === undefined
              ? null
              : parsed.expiresInMinutes * SECONDS_PER_MINUTE,
          join_policy_override: parsed.joinPolicyOverride ?? null,
        },
        RoomInviteCreateDtoSchema,
      )
    },
    preview(token) {
      const value = parseInput(TokenSchema, token, 'token')
      return transport.rpc(RPC.roomInvitePreview, { token: value }, RoomInvitePreviewDtoSchema)
    },
  }

  return {
    start(input) {
      const parsed = parseInput(RoomStartArgsSchema, input)
      return transport.rpc(
        RPC.roomStart,
        {
          context_type: parsed.contextType,
          context_id: parsed.contextId,
          title: parsed.title ?? null,
        },
        RoomStartDtoSchema,
      )
    },
    get(roomId) {
      const id = parseInput(RoomIdSchema, roomId, 'roomId')
      return transport.rpc(RPC.roomGet, { room_id: id }, RoomDtoSchema)
    },
    join(input) {
      const parsed = parseInput(RoomJoinInputSchema, input)
      return transport.rpc(
        RPC.roomJoin,
        {
          room_id: parsed.roomId,
          media_state: parsed.mediaState,
          consent_level: parsed.consentLevel,
        },
        RoomDtoSchema,
      )
    },
    joinWithInvite(input) {
      const parsed = parseInput(RoomInviteJoinInputSchema, input)
      return transport.rpc(
        RPC.roomInviteJoin,
        { token: parsed.token, media_state: parsed.mediaState, consent_level: parsed.consentLevel },
        RoomDtoSchema,
      )
    },
    setMediaState(input) {
      const parsed = parseInput(RoomSetMediaStateArgsSchema, input)
      return transport.rpc(
        RPC.roomSetMediaState,
        {
          room_id: parsed.roomId,
          media_state: parsed.mediaState,
          consent_level: parsed.consentLevel ?? null,
        },
        RoomVisibilityChangeDtoSchema,
      )
    },
    consent(input) {
      const parsed = parseInput(RoomConsentInputSchema, input)
      return transport.rpc(
        RPC.roomConsent,
        { room_id: parsed.roomId, level: parsed.level },
        RoomVisibilityChangeDtoSchema,
      )
    },
    setVisibility(input) {
      const parsed = parseInput(RoomSetVisibilityInputSchema, input)
      return transport.rpc(
        RPC.roomSetVisibility,
        { room_id: parsed.roomId, visibility: parsed.visibility, join_policy: parsed.joinPolicy },
        RoomVisibilityChangeDtoSchema,
      )
    },
    setJoinPolicy(input) {
      const parsed = parseInput(RoomSetJoinPolicyInputSchema, input)
      return transport.rpcVoid(RPC.roomSetJoinPolicy, {
        room_id: parsed.roomId,
        join_policy: parsed.joinPolicy,
      })
    },
    setGuestsDisabled(input) {
      const parsed = parseInput(RoomGuestsDisabledInputSchema, input)
      return transport.rpcVoid(RPC.roomSetGuestsDisabled, {
        room_id: parsed.roomId,
        disabled: parsed.disabled,
      })
    },
    admit(input) {
      const parsed = parseInput(RoomAdmitInputSchema, input)
      return transport.rpcVoid(RPC.roomAdmit, {
        room_id: parsed.roomId,
        participant_id: parsed.participantId,
      })
    },
    leave(roomId) {
      const id = parseInput(RoomIdSchema, roomId, 'roomId')
      return transport.rpc(RPC.roomLeave, { room_id: id }, RoomLeaveDtoSchema)
    },
    end(input) {
      const parsed = parseInput(RoomEndInputSchema, input)
      return transport.rpcVoid(RPC.roomEnd, {
        room_id: parsed.roomId,
        reason: parsed.reason ?? null,
      })
    },
    removeParticipant(input) {
      const parsed = parseInput(RoomRemoveParticipantArgsSchema, input)
      return transport.rpcVoid(RPC.roomRemoveParticipant, {
        room_id: parsed.roomId,
        participant_id: parsed.participantId,
        block_from_room: parsed.blockFromRoom,
      })
    },
    invites,
    token(roomId) {
      const id = parseInput(RoomIdSchema, roomId, 'roomId')
      return transport.server(
        { method: 'POST', path: SERVER_ROUTES.roomToken(id), body: {}, auth: 'required' },
        RoomTokenDtoSchema,
      )
    },
  }
}

export function createGuestNamespace(transport: Transport): GuestNamespace {
  return {
    createSession(input) {
      const parsed = parseInput(GuestSessionCreateArgsSchema, input)
      return transport.rpc(
        RPC.guestSessionCreate,
        {
          token: parsed.inviteToken,
          display_name: parsed.displayName,
          device_fingerprint_hash: parsed.deviceFingerprintHash ?? null,
          // Only sent when chosen: the RPC defaults to `audio` (DB_API §3).
          media_state: parsed.mediaState ?? undefined,
        },
        GuestSessionDtoSchema,
      )
    },
    get: () => transport.rpc(RPC.guestSessionGet, {}, GuestSessionsDtoSchema),
  }
}
