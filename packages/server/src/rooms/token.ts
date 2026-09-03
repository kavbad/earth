/**
 * LiveKit token minting (ARCHITECTURE §6, §10; spec §105). The database decides what the caller
 * may do in a room (`room_media_grant`, DB_API §3); this module only translates that grant into
 * JWT claims and never adds a permission the grant does not carry: no room admin, no room create,
 * no metadata self-updates, no list/record/ingress rights. One token per join, TTL from the grant.
 */
import {
  EarthError,
  MEDIA_GRANT_TTL_SECONDS,
  type MediaGrantDto,
  MediaGrantDtoSchema,
  type MediaIdentity,
  type ParticipantRole,
  type RoomTokenDto,
  RoomTokenDtoSchema,
  isUuid,
  parseMediaIdentity,
} from '@earth/domain'
import { AccessToken, type VideoGrant } from 'livekit-server-sdk'

import type { ServerDeps } from '../deps'
import { type EarthRequest, type EarthResponse, ok, parseOutput, requireBearer, rpc } from '../http'

export const ROOM_MEDIA_GRANT_RPC = 'room_media_grant' as const

/**
 * The longest-lived token the route mints, whatever the grant says (ARCHITECTURE §10: "Token TTL
 * 2 hours"). The grant may shorten it, never lengthen it.
 */
export const MAX_TOKEN_TTL_SECONDS = MEDIA_GRANT_TTL_SECONDS

/** The TTL actually signed: the grant's, capped at `MAX_TOKEN_TTL_SECONDS`. */
export function effectiveTtlSeconds(grant: Pick<MediaGrantDto, 'ttlSeconds'>): number {
  return Math.min(grant.ttlSeconds, MAX_TOKEN_TTL_SECONDS)
}

export interface LiveKitTokenSigner {
  readonly apiKey: string
  readonly apiSecret: string
  now(): Date
}

export interface BuiltLiveKitToken {
  readonly token: string
  readonly identity: MediaIdentity
  /** ISO 8601, `now + grant.ttlSeconds`. */
  readonly expiresAt: string
}

/** Participant metadata carried in the token (visible to other participants via the SDK). */
export interface LiveKitTokenMetadata {
  readonly isGuest: boolean
  readonly role: ParticipantRole
}

export function tokenMetadataFor(grant: MediaGrantDto): LiveKitTokenMetadata {
  const parsed = parseMediaIdentity(grant.identity)
  return { isGuest: parsed?.kind === 'guest', role: grant.role }
}

/**
 * The exact video grant a `MediaGrantDto` maps to. Every permission not carried by the grant is
 * explicitly `false` so a future SDK default can never widen a token.
 */
export function videoGrantFor(grant: MediaGrantDto): VideoGrant {
  return {
    room: grant.livekitRoom,
    roomJoin: true,
    canPublish: grant.canPublish,
    canSubscribe: grant.canSubscribe,
    canPublishData: grant.canPublishData,
    canUpdateOwnMetadata: false,
    roomAdmin: false,
    roomCreate: false,
    roomList: false,
    roomRecord: false,
    ingressAdmin: false,
    hidden: false,
    recorder: false,
    agent: false,
    canSubscribeMetrics: false,
    canManageAgentSession: false,
  }
}

export async function buildLiveKitToken(
  grant: MediaGrantDto,
  signer: LiveKitTokenSigner,
): Promise<BuiltLiveKitToken> {
  const validGrant = MediaGrantDtoSchema.parse(grant)
  const ttlSeconds = effectiveTtlSeconds(validGrant)
  const issuedAt = signer.now()
  const token = new AccessToken(signer.apiKey, signer.apiSecret, {
    identity: validGrant.identity,
    name: validGrant.name,
    ttl: ttlSeconds,
    metadata: JSON.stringify(tokenMetadataFor(validGrant)),
  })
  token.addGrant(videoGrantFor(validGrant))
  const jwt = await token.toJwt()
  return {
    token: jwt,
    identity: validGrant.identity,
    expiresAt: new Date(issuedAt.getTime() + ttlSeconds * 1000).toISOString(),
  }
}

/** `true` when the grant is for the room the caller asked for (uuids compared case-insensitively). */
export function grantMatchesRoom(
  grant: Pick<MediaGrantDto, 'livekitRoom'>,
  roomId: string,
): boolean {
  return grant.livekitRoom.toLowerCase() === roomId.toLowerCase()
}

/** `POST /api/rooms/:id/token` — grant as the caller (Human or Guest), then mint. */
export async function handleRoomToken(
  deps: ServerDeps,
  req: EarthRequest,
  roomId: string,
): Promise<EarthResponse> {
  const accessToken = requireBearer(req)
  if (!isUuid(roomId)) {
    throw new EarthError('invalid_input', { details: { field: 'roomId', reason: 'not_a_uuid' } })
  }
  const grant = await rpc(
    deps,
    accessToken,
    ROOM_MEDIA_GRANT_RPC,
    { room_id: roomId },
    MediaGrantDtoSchema,
  )
  if (!grantMatchesRoom(grant, roomId)) {
    // A grant for another room is a database/contract bug; a token for it must never be minted.
    throw new EarthError('internal', {
      message: 'room_media_grant named a different room than requested',
      details: { what: 'MediaGrantDto', reason: 'room_mismatch' },
    })
  }
  const built = await buildLiveKitToken(grant, {
    apiKey: deps.livekit.apiKey,
    apiSecret: deps.livekit.apiSecret,
    now: () => deps.now(),
  })
  const dto: RoomTokenDto = parseOutput(
    RoomTokenDtoSchema,
    {
      token: built.token,
      url: deps.livekit.url,
      identity: built.identity,
      expiresAt: built.expiresAt,
    },
    'RoomTokenDto',
  )
  return ok(dto)
}
