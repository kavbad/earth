/**
 * `rtc_diagnostic_record(kind, room_id, payload)` (spec §14, §109; DB_API §8; 0800): Humans and
 * Guests report what happened in a room they were in (or before any room), attributed to their
 * Human or Guest session; coordinates never land in the payload; the service inserts directly.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  PERMISSION_DENIED,
  attempt,
  befriend,
  count,
  createGuest,
  createGuestSession,
  createHuman,
  createRoomInvite,
  createUnclaimed,
  diagnosticRows,
  human,
  joinRoom,
  scalar,
  sqlstate,
  startStandaloneRoom,
  type Guest,
  type Human,
} from './fixtures'

describe('rtc_diagnostic_record (DB_API §8)', () => {
  let db: TestDb
  let host: Human
  let friend: Human
  let stranger: Human
  let roomId: string
  let guest: Guest
  let guestSessionId: string

  const record = (as: RoleSpec, kind: string, room: string | null, payload: unknown = {}) =>
    db.rpc<{ id: string; createdAt: string }>(
      'rtc_diagnostic_record',
      { kind, room_id: room, payload: payload === null ? null : JSON.stringify(payload) },
      as,
    )

  beforeAll(async () => {
    db = await createTestDb()
    host = await human(db, 'Host')
    friend = await human(db, 'Friend')
    stranger = await human(db, 'Stranger')
    await befriend(db, host, friend)
    roomId = (await startStandaloneRoom(db, host, 'Hangout')).room.id
    await joinRoom(db, roomId, friend, 'watching')
    const invite = await createRoomInvite(db, roomId, host)
    guest = await createGuest(db)
    guestSessionId = (await createGuestSession(db, guest, invite.token, 'Sam')).guestSessionId
  })

  afterAll(async () => {
    await db.drop()
  })

  it('authorization: visitor, service, claiming, unclaimed and inactive Humans are refused', async () => {
    await db.expectError(record('visitor', 'connect_failed', null), 'not_authenticated')
    await db.expectError(record('service', 'connect_failed', null), 'forbidden')
    const pending = await createHuman(db, { handle: 'pendingone', status: 'pending', identity: false })
    await db.expectError(record(pending.as, 'connect_failed', null), 'not_a_human')
    const unclaimed = await createUnclaimed(db)
    await db.expectError(record(unclaimed.as, 'connect_failed', null), 'not_a_human')
    const suspended = await createHuman(db, { handle: 'suspendedone', status: 'suspended' })
    await db.expectError(record(suspended.as, 'connect_failed', null), 'human_not_active')
    expect(await count(db, 'public.rtc_diagnostics')).toBe(0)
  })

  it('a Human records without a room (failures before any room) and returns {id, createdAt}', async () => {
    const result = await record(host.as, 'network_unavailable', null, { ts: '2026-09-03T10:00:00Z', receivedAt: '2026-09-03T10:00:01Z' })
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const rows = await diagnosticRows(db, 'id = $1', [result.id])
    expect(rows[0]).toEqual({
      id: result.id,
      human_id: host.humanId,
      guest_session_id: null,
      room_id: null,
      kind: 'network_unavailable',
      payload: { ts: '2026-09-03T10:00:00Z', receivedAt: '2026-09-03T10:00:01Z' },
    })
  })

  it('with a room: participants of any status may record; strangers get not_in_room; unknown rooms room_not_found', async () => {
    const asHost = await record(host.as, 'connected', roomId)
    expect((await diagnosticRows(db, 'id = $1', [asHost.id]))[0]).toMatchObject({ human_id: host.humanId, room_id: roomId, guest_session_id: null })
    await record(friend.as, 'reconnecting', roomId)
    await db.rpc('room_leave', { room_id: roomId }, friend.as)
    await record(friend.as, 'reconnect_failed', roomId)
    expect(await count(db, 'public.rtc_diagnostics', 'human_id = $1 and room_id = $2', [friend.humanId, roomId])).toBe(2)
    await db.expectError(record(stranger.as, 'connected', roomId), 'not_in_room')
    await db.expectError(record(host.as, 'connected', randomUUID()), 'room_not_found')
  })

  it('a Guest is attributed to their session of the room, even after it expired; other rooms are not_in_room', async () => {
    const own = await record(guest.as, 'track_publish_failed', roomId, { source: 'microphone' })
    expect((await diagnosticRows(db, 'id = $1', [own.id]))[0]).toMatchObject({
      human_id: null,
      guest_session_id: guestSessionId,
      room_id: roomId,
      payload: { source: 'microphone' },
    })
    const other = (await startStandaloneRoom(db, stranger, 'Elsewhere')).room.id
    await db.expectError(record(guest.as, 'connect_failed', other), 'not_in_room')
    const noRoom = await record(guest.as, 'network_unavailable', null)
    expect((await diagnosticRows(db, 'id = $1', [noRoom.id]))[0]).toMatchObject({ human_id: null, guest_session_id: null, room_id: null })

    await db.sql.query(`update public.guest_sessions set expires_at = created_at + interval '1 millisecond' where id = $1`, [guestSessionId])
    expect(await scalar(db, 'expires_at < now() from public.guest_sessions where id = $1', [guestSessionId])).toBe(true)
    const expired = await record(guest.as, 'reconnect_failed', roomId)
    expect((await diagnosticRows(db, 'id = $1', [expired.id]))[0]?.guest_session_id).toBe(guestSessionId)
    // A second Guest of the same room is attributed to their own session, never the first one's.
    const invite = await createRoomInvite(db, roomId, host)
    const second = await createGuest(db)
    const secondSession = (await createGuestSession(db, second, invite.token, 'Kim')).guestSessionId
    const theirs = await record(second.as, 'connected', roomId)
    expect((await diagnosticRows(db, 'id = $1', [theirs.id]))[0]?.guest_session_id).toBe(secondSession)
  })

  it('validates kind and payload (invalid_input)', async () => {
    for (const kind of ['', '  ', 'Connect Failed', 'connect-failed', '1st', 'x'.repeat(65)]) {
      await db.expectError(record(host.as, kind, null), 'invalid_input')
    }
    await db.expectError(record(host.as, 'connected', null, ['not', 'an', 'object']), 'invalid_input')
    await db.expectError(record(host.as, 'connected', null, 'text'), 'invalid_input')
    await db.expectError(
      record(host.as, 'connected', null, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i]))),
      'invalid_input',
    )
    await db.expectError(record(host.as, 'connected', null, { blob: 'x'.repeat(17 * 1024) }), 'invalid_input')
    // Kind is trimmed; a null payload means an empty one.
    const trimmed = await record(host.as, '  media_device_error ', null, null)
    expect((await diagnosticRows(db, 'id = $1', [trimmed.id]))[0]).toMatchObject({ kind: 'media_device_error', payload: {} })
  })

  it('strips coordinate keys and coordinate-like values from the payload', async () => {
    const result = await record(host.as, 'connect_failed', roomId, {
      ts: '2026-09-03T10:00:00Z',
      receivedAt: '2026-09-03T10:00:01Z',
      attempt: 2,
      lat: 37.7749,
      longitude: -122.4194,
      location: 'home',
      deviceLatLng: '37.7749,-122.4194',
      lastKnown: 'geo:37.7749,-122.4194',
      nested: { coords: [1, 2], reason: 'ice' },
      latencyMs: 40,
    })
    expect((await diagnosticRows(db, 'id = $1', [result.id]))[0]?.payload).toEqual({
      ts: '2026-09-03T10:00:00Z',
      receivedAt: '2026-09-03T10:00:01Z',
      attempt: 2,
      nested: { reason: 'ice' },
      latencyMs: 40,
    })
  })

  it('is rate limited to 120 per 10 minutes per Human', async () => {
    const chatty = await human(db, 'Chatty')
    for (let i = 0; i < 120; i += 1) await record(chatty.as, 'connect_attempt', null, { attempt: i })
    await db.expectError(record(chatty.as, 'connect_attempt', null), 'rate_limited')
    expect(await count(db, 'public.rtc_diagnostics', 'human_id = $1', [chatty.humanId])).toBe(120)
  })

  it('the service inserts directly; no client reads the table', async () => {
    await db.sql.query(
      `insert into public.rtc_diagnostics (room_id, kind, payload) values ($1, 'webhook_out_of_order', '{"event": "participant_left"}')`,
      [roomId],
    )
    expect(await count(db, 'public.rtc_diagnostics', "kind = 'webhook_out_of_order'")).toBe(1)
    for (const as of ['visitor', host.as, guest.as] as const) {
      expect(sqlstate(await attempt(db, as, 'select * from public.rtc_diagnostics'))).toBe(PERMISSION_DENIED)
    }
  })
})
