/**
 * `rooms` and `guest` (DB_API §3; ARCHITECTURE §10; spec PART VIII).
 */
import {
  type GuestSessionDto,
  type RoomConsentInput,
  RoomConsentInputSchema,
  type RoomDto,
  type RoomId,
  RoomIdSchema,
  type RoomInviteCreateDto,
  type RoomInviteCreateInput,
  RoomInviteCreateInputSchema,
  type RoomInvitePreviewDto,
  type RoomJoinInput,
  RoomJoinInputSchema,
  type RoomLeaveDto,
  type RoomSetJoinPolicyInput,
  RoomSetJoinPolicyInputSchema,
  type RoomSetVisibilityInput,
  RoomSetVisibilityInputSchema,
  type RoomStartDto,
  type RoomTokenDto,
  type RoomVisibilityChangeDto,
} from '@earth/domain'
import { z } from 'zod'

import {
  type GuestSessionCreateArgs,
  GuestSessionCreateArgsSchema,
  type GuestSessionsDto,
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
import { CALLS } from '../manifest'
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
  /** `room_set_join_policy(room_id, join_policy)` (moderator): the room afterwards. */
  setJoinPolicy(input: RoomSetJoinPolicyInput): Promise<RoomDto>
  /** `room_set_guests_disabled(room_id, disabled)` (moderator): the room afterwards. */
  setGuestsDisabled(input: RoomGuestsDisabledInput): Promise<RoomDto>
  /** `room_admit(room_id, participant_id)`: `waiting` → `active`; the room afterwards. */
  admit(input: RoomAdmitInput): Promise<RoomDto>
  /** `room_leave(room_id)`; `transferredTo` names the new moderator when the leaver held the room. */
  leave(roomId: RoomId): Promise<RoomLeaveDto>
  /** `room_end(room_id, reason)` (moderator): the ended room. */
  end(input: RoomEndInput): Promise<RoomDto>
  /** `room_remove_participant(room_id, participant_id, block_from_room)` (moderator): the room afterwards. */
  removeParticipant(input: RoomRemoveParticipantArgs): Promise<RoomDto>
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
      return transport.call(CALLS.roomsInvitesCreate, {
        room_id: parsed.roomId,
        expires_in_seconds:
          parsed.expiresInMinutes === null || parsed.expiresInMinutes === undefined
            ? null
            : parsed.expiresInMinutes * SECONDS_PER_MINUTE,
        join_policy_override: parsed.joinPolicyOverride ?? null,
      })
    },
    preview(token) {
      const value = parseInput(TokenSchema, token, 'token')
      return transport.call(CALLS.roomsInvitesPreview, { token: value })
    },
  }

  return {
    start(input) {
      const parsed = parseInput(RoomStartArgsSchema, input)
      return transport.call(CALLS.roomsStart, {
        context_type: parsed.contextType,
        context_id: parsed.contextId,
        title: parsed.title ?? null,
      })
    },
    get(roomId) {
      const id = parseInput(RoomIdSchema, roomId, 'roomId')
      return transport.call(CALLS.roomsGet, { room_id: id })
    },
    join(input) {
      const parsed = parseInput(RoomJoinInputSchema, input)
      return transport.call(CALLS.roomsJoin, {
        room_id: parsed.roomId,
        media_state: parsed.mediaState,
        consent_level: parsed.consentLevel,
      })
    },
    joinWithInvite(input) {
      const parsed = parseInput(RoomInviteJoinInputSchema, input)
      return transport.call(CALLS.roomsJoinWithInvite, {
        token: parsed.token,
        media_state: parsed.mediaState,
        consent_level: parsed.consentLevel,
      })
    },
    setMediaState(input) {
      const parsed = parseInput(RoomSetMediaStateArgsSchema, input)
      return transport.call(CALLS.roomsSetMediaState, {
        room_id: parsed.roomId,
        media_state: parsed.mediaState,
        consent_level: parsed.consentLevel ?? null,
      })
    },
    consent(input) {
      const parsed = parseInput(RoomConsentInputSchema, input)
      return transport.call(CALLS.roomsConsent, { room_id: parsed.roomId, level: parsed.level })
    },
    setVisibility(input) {
      const parsed = parseInput(RoomSetVisibilityInputSchema, input)
      return transport.call(CALLS.roomsSetVisibility, {
        room_id: parsed.roomId,
        visibility: parsed.visibility,
        join_policy: parsed.joinPolicy,
      })
    },
    setJoinPolicy(input) {
      const parsed = parseInput(RoomSetJoinPolicyInputSchema, input)
      return transport.call(CALLS.roomsSetJoinPolicy, {
        room_id: parsed.roomId,
        join_policy: parsed.joinPolicy,
      })
    },
    setGuestsDisabled(input) {
      const parsed = parseInput(RoomGuestsDisabledInputSchema, input)
      return transport.call(CALLS.roomsSetGuestsDisabled, {
        room_id: parsed.roomId,
        disabled: parsed.disabled,
      })
    },
    admit(input) {
      const parsed = parseInput(RoomAdmitInputSchema, input)
      return transport.call(CALLS.roomsAdmit, {
        room_id: parsed.roomId,
        participant_id: parsed.participantId,
      })
    },
    leave(roomId) {
      const id = parseInput(RoomIdSchema, roomId, 'roomId')
      return transport.call(CALLS.roomsLeave, { room_id: id })
    },
    end(input) {
      const parsed = parseInput(RoomEndInputSchema, input)
      return transport.call(CALLS.roomsEnd, {
        room_id: parsed.roomId,
        reason: parsed.reason ?? null,
      })
    },
    removeParticipant(input) {
      const parsed = parseInput(RoomRemoveParticipantArgsSchema, input)
      return transport.call(CALLS.roomsRemoveParticipant, {
        room_id: parsed.roomId,
        participant_id: parsed.participantId,
        block_from_room: parsed.blockFromRoom,
      })
    },
    invites,
    token(roomId) {
      const id = parseInput(RoomIdSchema, roomId, 'roomId')
      return transport.route(CALLS.roomsToken, { params: { id }, body: {} })
    },
  }
}

export function createGuestNamespace(transport: Transport): GuestNamespace {
  return {
    createSession(input) {
      const parsed = parseInput(GuestSessionCreateArgsSchema, input)
      return transport.call(CALLS.guestCreateSession, {
        token: parsed.inviteToken,
        display_name: parsed.displayName,
        device_fingerprint_hash: parsed.deviceFingerprintHash ?? null,
        // Only sent when chosen: the RPC defaults to `audio` (DB_API §3).
        media_state: parsed.mediaState ?? undefined,
      })
    },
    get: () => transport.call(CALLS.guestGet, {}),
  }
}
