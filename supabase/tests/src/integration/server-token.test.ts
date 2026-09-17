/**
 * `POST /api/rooms/:id/token` end to end (ARCHITECTURE §6, §10; spec §105): the route asks the real
 * `room_media_grant` as the caller and mints a LiveKit token whose claims are exactly the grant —
 * for a publishing Human, a watching viewer and a Guest — and answers the database's own code for
 * outsiders and ended rooms.
 */
import {
  MEDIA_GRANT_TTL_SECONDS,
  MediaGrantDtoSchema,
  RoomTokenDtoSchema,
  httpStatusForErrorCode,
} from '@earth/domain'
import { TokenVerifier } from 'livekit-server-sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type TestDb } from '../harness'
import {
  befriend,
  createGuest,
  createGuestSession,
  createRoomInvite,
  human,
  joinRoom,
  startStandaloneRoom,
  type Guest,
  type Human,
} from '../rooms/fixtures'
import {
  TEST_LIVEKIT,
  createEarthServer,
  createServerTestDeps,
  errorCodeOf,
  fakeRequest,
  type EarthServer,
  type ServerTestDeps,
} from './server-deps'

describe('POST /api/rooms/:id/token (server tier ↔ room_media_grant)', () => {
  let db: TestDb
  let ctx: ServerTestDeps
  let server: EarthServer
  let host: Human
  let viewer: Human
  let outsider: Human
  let guest: Guest
  let guestSessionId: string
  let roomId: string
  const verifier = new TokenVerifier(TEST_LIVEKIT.apiKey, TEST_LIVEKIT.apiSecret)

  async function token(bearer: string | undefined, room: string = roomId) {
    return server.handle(
      fakeRequest({
        method: 'POST',
        url: `/api/rooms/${room}/token`,
        ...(bearer === undefined ? {} : { bearer }),
      }),
    )
  }

  beforeAll(async () => {
    db = await createTestDb()
    ctx = createServerTestDeps(db)
    server = createEarthServer(ctx.deps)
    host = await human(db, 'Host')
    viewer = await human(db, 'Viewer')
    outsider = await human(db, 'Outsider')
    await befriend(db, host, viewer)
    roomId = (await startStandaloneRoom(db, host, 'Jam')).room.id
    await joinRoom(db, roomId, viewer, 'watching')
    const invite = await createRoomInvite(db, roomId, host)
    guest = await createGuest(db)
    guestSessionId = (await createGuestSession(db, guest, invite.token, 'Sam')).guestSessionId
  })

  afterAll(async () => {
    await db.drop()
  })

  it('mints a token for a publishing Human whose claims are exactly the grant', async () => {
    const grant = MediaGrantDtoSchema.parse(
      await db.rpc('room_media_grant', { room_id: roomId }, host.as),
    )
    expect(grant).toMatchObject({
      identity: `h:${host.humanId}`,
      role: 'initiator',
      canPublish: true,
      ttlSeconds: MEDIA_GRANT_TTL_SECONDS,
    })
    const bearer = ctx.tokens.for(host.as)
    const res = await token(bearer)
    expect(res.status).toBe(200)
    const dto = RoomTokenDtoSchema.parse(res.body)
    expect(dto).toMatchObject({
      url: TEST_LIVEKIT.url,
      identity: grant.identity,
      expiresAt: new Date(ctx.clock.now.getTime() + grant.ttlSeconds * 1000).toISOString(),
    })
    expect(ctx.callsTo('room_media_grant').at(-1)).toMatchObject({
      client: `user:${bearer}`,
      as: host.as,
      args: { room_id: roomId },
    })

    const claims = await verifier.verify(dto.token)
    expect(claims.iss).toBe(TEST_LIVEKIT.apiKey)
    expect(claims.sub).toBe(grant.identity)
    expect(claims.name).toBe(grant.name)
    expect(claims.name).toBe('Host')
    expect(claims.video).toEqual({
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
    })
    expect(claims.video?.room).toBe(roomId)
    expect((claims.exp ?? 0) - (claims.nbf ?? 0)).toBe(grant.ttlSeconds)
    expect(JSON.parse(claims.metadata ?? '{}')).toEqual({ isGuest: false, role: grant.role })
    expect(claims.sip).toBeUndefined()
    expect(claims.roomConfig).toBeUndefined()
  })

  it('a watching viewer may subscribe but never publish', async () => {
    const grant = MediaGrantDtoSchema.parse(
      await db.rpc('room_media_grant', { room_id: roomId }, viewer.as),
    )
    expect(grant).toMatchObject({ role: 'viewer', canPublish: false, canSubscribe: true })
    const res = await token(ctx.tokens.for(viewer.as))
    expect(res.status).toBe(200)
    const claims = await verifier.verify(RoomTokenDtoSchema.parse(res.body).token)
    expect(claims.sub).toBe(`h:${viewer.humanId}`)
    expect(claims.video).toMatchObject({
      room: roomId,
      canPublish: false,
      canSubscribe: true,
      canPublishData: true,
      roomAdmin: false,
    })
    expect(JSON.parse(claims.metadata ?? '{}')).toEqual({ isGuest: false, role: 'viewer' })
  })

  it('a Guest gets its g: identity and display name', async () => {
    const grant = MediaGrantDtoSchema.parse(
      await db.rpc('room_media_grant', { room_id: roomId }, guest.as),
    )
    expect(grant).toMatchObject({
      identity: `g:${guestSessionId}`,
      name: 'Sam',
      role: 'participant',
      canPublish: true,
    })
    const res = await token(ctx.tokens.for(guest.as))
    expect(res.status).toBe(200)
    const dto = RoomTokenDtoSchema.parse(res.body)
    expect(dto.identity).toBe(`g:${guestSessionId}`)
    const claims = await verifier.verify(dto.token)
    expect(claims.sub).toBe(`g:${guestSessionId}`)
    expect(claims.name).toBe('Sam')
    expect(claims.video).toMatchObject({ room: roomId, canPublish: true, canSubscribe: true })
    expect(JSON.parse(claims.metadata ?? '{}')).toEqual({ isGuest: true, role: 'participant' })
  })

  it('answers the database code for outsiders, and 401 without a usable bearer', async () => {
    const forbidden = await token(ctx.tokens.for(outsider.as))
    expect(forbidden.status).toBe(httpStatusForErrorCode('not_in_room'))
    expect(errorCodeOf(forbidden)).toBe('not_in_room')

    const anonymous = await token(undefined)
    expect(anonymous.status).toBe(401)
    expect(errorCodeOf(anonymous)).toBe('not_authenticated')

    const unknown = await token('not-a-session')
    expect(unknown.status).toBe(401)
    expect(errorCodeOf(unknown)).toBe('not_authenticated')

    const malformed = await token(ctx.tokens.for(host.as), 'not-a-room')
    expect(malformed.status).toBe(400)
    expect(errorCodeOf(malformed)).toBe('invalid_input')
  })

  it('an ended room answers room_ended with the domain status', async () => {
    await db.rpc('room_end', { room_id: roomId }, host.as)
    const res = await token(ctx.tokens.for(host.as))
    expect(errorCodeOf(res)).toBe('room_ended')
    expect(res.status).toBe(httpStatusForErrorCode('room_ended'))
    expect(res.status).toBe(410)
  })
})
