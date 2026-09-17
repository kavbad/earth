/**
 * `POST /api/livekit/webhook` end to end (ARCHITECTURE §6; DB_API §3): a body signed the way LiveKit
 * signs it (a JWT under the API secret carrying the body's sha256) reconciles `room_participants`
 * through the service RPC `room_participant_sync`; an older event is acknowledged and ignored as
 * out of order; an unsigned or foreign body never reaches the database.
 */
import { createHash } from 'node:crypto'

import { AccessToken } from 'livekit-server-sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type TestDb } from '../harness'
import {
  befriend,
  human,
  joinRoom,
  participantStatus,
  roomRow,
  startStandaloneRoom,
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

/** Signs a webhook body exactly like LiveKit: a JWT under the API secret carrying the body sha256. */
async function sign(
  body: string,
  apiKey: string = TEST_LIVEKIT.apiKey,
  apiSecret: string = TEST_LIVEKIT.apiSecret,
): Promise<string> {
  const token = new AccessToken(apiKey, apiSecret, { ttl: '10m' })
  token.sha256 = createHash('sha256').update(body).digest('base64')
  return token.toJwt()
}

interface EventInput {
  event: string
  roomName: string
  identity?: string
  atSeconds: number
  id: string
}

function event(input: EventInput): string {
  return JSON.stringify({
    event: input.event,
    id: input.id,
    createdAt: input.atSeconds,
    room: { name: input.roomName, sid: 'RM_1' },
    ...(input.identity === undefined
      ? {}
      : { participant: { identity: input.identity, sid: 'PA_1' } }),
  })
}

describe('POST /api/livekit/webhook (server tier ↔ room_participant_sync)', () => {
  let db: TestDb
  let ctx: ServerTestDeps
  let server: EarthServer
  let host: Human
  let member: Human
  let roomId: string

  async function webhook(body: string, authorization?: string) {
    return server.handle(
      fakeRequest({
        method: 'POST',
        url: '/api/livekit/webhook',
        headers: authorization === undefined ? {} : { authorization },
        body,
      }),
    )
  }

  beforeAll(async () => {
    db = await createTestDb()
    ctx = createServerTestDeps(db)
    server = createEarthServer(ctx.deps)
    host = await human(db, 'Host')
    member = await human(db, 'Member')
    await befriend(db, host, member)
    roomId = (await startStandaloneRoom(db, host, 'Jam')).room.id
    await joinRoom(db, roomId, member, 'camera', 'friends')
  })

  afterAll(async () => {
    await db.drop()
  })

  it('rejects unsigned, foreign-signed and tampered bodies without touching the database', async () => {
    const body = event({
      event: 'participant_left',
      roomName: roomId,
      identity: `h:${member.humanId}`,
      atSeconds: Math.floor(Date.now() / 1000),
      id: 'EV_X',
    })
    const unsigned = await webhook(body)
    expect(unsigned.status).toBe(401)
    expect(errorCodeOf(unsigned)).toBe('not_authenticated')
    const foreign = await webhook(body, await sign(body, TEST_LIVEKIT.apiKey, 'another-secret'))
    expect(foreign.status).toBe(401)
    const tampered = await webhook(body.replace('EV_X', 'EV_Y'), await sign(body))
    expect(tampered.status).toBe(401)
    expect(ctx.calls).toHaveLength(0)
    expect(await participantStatus(db, roomId, member.humanId)).toMatchObject({ status: 'active' })
  })

  it('participant_left signed as LiveKit marks the seat left; an older event is out of order', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const left = event({
      event: 'participant_left',
      roomName: roomId,
      identity: `h:${member.humanId}`,
      atSeconds: nowSeconds + 2,
      id: 'EV_1',
    })
    const res = await webhook(left, await sign(left))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, event: 'participant_left', handled: true })
    expect(await participantStatus(db, roomId, member.humanId)).toMatchObject({ status: 'left' })
    expect(ctx.callsTo('room_participant_sync').at(-1)).toMatchObject({
      client: 'admin',
      as: 'service',
      args: {
        room_id: roomId,
        livekit_identity: `h:${member.humanId}`,
        event: 'participant_left',
        at: new Date((nowSeconds + 2) * 1000).toISOString(),
      },
      data: { applied: true, ignored: false },
    })

    // A leave from before the seat left is acknowledged (LiveKit must not retry) but ignored.
    const stale = event({
      event: 'participant_left',
      roomName: roomId,
      identity: `h:${member.humanId}`,
      atSeconds: nowSeconds - 60,
      id: 'EV_0',
    })
    const staleRes = await webhook(stale, await sign(stale))
    expect(staleRes.status).toBe(200)
    expect(staleRes.body).toEqual({
      ok: true,
      event: 'participant_left',
      handled: true,
      reason: 'out_of_order',
    })
    expect(ctx.callsTo('room_participant_sync').at(-1)?.data).toMatchObject({
      applied: false,
      ignored: true,
      reason: 'out_of_order',
    })
    expect(await participantStatus(db, roomId, member.humanId)).toMatchObject({ status: 'left' })

    // A later join re-activates the seat.
    const rejoin = event({
      event: 'participant_joined',
      roomName: roomId,
      identity: `h:${member.humanId}`,
      atSeconds: nowSeconds + 10,
      id: 'EV_2',
    })
    expect((await webhook(rejoin, await sign(rejoin))).body).toEqual({
      ok: true,
      event: 'participant_joined',
      handled: true,
    })
    expect(await participantStatus(db, roomId, member.humanId)).toMatchObject({ status: 'active' })

    // The host leaving hands moderation to the member (spec §61); room_finished ends the room.
    const hostLeft = event({
      event: 'participant_left',
      roomName: roomId,
      identity: `h:${host.humanId}`,
      atSeconds: nowSeconds + 12,
      id: 'EV_3',
    })
    expect((await webhook(hostLeft, await sign(hostLeft))).status).toBe(200)
    expect(await participantStatus(db, roomId, host.humanId)).toMatchObject({ status: 'left' })
    expect(await participantStatus(db, roomId, member.humanId)).toMatchObject({
      status: 'active',
      role: 'moderator',
    })
    const finished = event({
      event: 'room_finished',
      roomName: roomId,
      atSeconds: nowSeconds + 20,
      id: 'EV_4',
    })
    expect((await webhook(finished, await sign(finished))).body).toEqual({
      ok: true,
      event: 'room_finished',
      handled: true,
    })
    expect(ctx.callsTo('room_participant_sync').at(-1)?.args).toMatchObject({
      room_id: roomId,
      livekit_identity: null,
      event: 'room_finished',
    })
    expect(await roomRow(db, roomId)).toMatchObject({
      status: 'ended',
      ended_reason: 'livekit_finished',
    })
  })

  it('events for rooms or participants that are not Earth’s are acknowledged and ignored', async () => {
    const before = ctx.callsTo('room_participant_sync').length
    const foreignRoom = event({
      event: 'participant_left',
      roomName: 'lobby',
      identity: `h:${member.humanId}`,
      atSeconds: Math.floor(Date.now() / 1000),
      id: 'EV_5',
    })
    expect((await webhook(foreignRoom, await sign(foreignRoom))).body).toEqual({
      ok: true,
      event: 'participant_left',
      handled: false,
      reason: 'room_not_earth',
    })
    const foreignIdentity = event({
      event: 'participant_joined',
      roomName: roomId,
      identity: 'PA_someone',
      atSeconds: Math.floor(Date.now() / 1000),
      id: 'EV_6',
    })
    expect((await webhook(foreignIdentity, await sign(foreignIdentity))).body).toEqual({
      ok: true,
      event: 'participant_joined',
      handled: false,
      reason: 'identity_not_earth',
    })
    const other = event({
      event: 'track_published',
      roomName: roomId,
      identity: `h:${member.humanId}`,
      atSeconds: Math.floor(Date.now() / 1000),
      id: 'EV_7',
    })
    expect((await webhook(other, await sign(other))).body).toEqual({
      ok: true,
      event: 'track_published',
      handled: false,
      reason: 'unhandled_event',
    })
    expect(ctx.callsTo('room_participant_sync')).toHaveLength(before)
  })
})
