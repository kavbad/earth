/**
 * Guest reporting (spec §42, §81 "Every Guest: ... report"; DB_API §7 "Guests may report only
 * rooms/participants of their room"): a Guest reports their own live room and the Humans / Guests
 * who hold a seat in it, nothing else, at the stricter 5/h budget; Humans report Guests of rooms they
 * can see. A Guest is never a Human (spec §128): no report history RPC, no other target types.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type TestDb } from '../harness'
import {
  auditRows,
  createGuest,
  createGuestSession,
  createPost,
  createReport,
  createRoomInvite,
  directConversation,
  errorCode,
  getRoom,
  human,
  myReports,
  reportErrorCode,
  reportRow,
  resetRateLimitsFor,
  rpcAt,
  secondsFromNow,
  sendMessage,
  startStandaloneRoom,
  type Guest,
  type Human,
} from './fixtures'

describe('guest reports (DB_API §7)', () => {
  let db: TestDb
  let host: Human
  let cohost: Human
  let stranger: Human
  let roomId: string
  let otherRoomId: string
  let guest1: Guest
  let guest2: Guest
  let guest3: Guest
  let session1: string
  let session2: string
  let session3: string

  beforeAll(async () => {
    db = await createTestDb()
    host = await human(db, 'Host')
    cohost = await human(db, 'Cohost')
    stranger = await human(db, 'Stranger')
    await db.sql.query(
      `insert into public.relationships (source_human_id, target_human_id, type) values ($1, $2, 'friend'), ($2, $1, 'friend')`,
      [host.humanId, cohost.humanId],
    )
    const room = await startStandaloneRoom(db, host, 'Kitchen')
    roomId = room.room.id
    await db.rpc('room_join', { room_id: roomId, media_state: 'camera', consent_level: 'friends' }, cohost.as)
    const invite = await createRoomInvite(db, roomId, host)
    guest1 = await createGuest(db)
    guest2 = await createGuest(db)
    session1 = (await createGuestSession(db, guest1, invite.token, 'Sam')).guestSessionId
    session2 = (await createGuestSession(db, guest2, invite.token, 'Pat')).guestSessionId

    const other = await startStandaloneRoom(db, stranger, 'Elsewhere')
    otherRoomId = other.room.id
    const otherInvite = await createRoomInvite(db, otherRoomId, stranger)
    guest3 = await createGuest(db)
    session3 = (await createGuestSession(db, guest3, otherInvite.token, 'Alex')).guestSessionId
  })

  afterAll(async () => {
    await db.drop()
  })

  it('a Guest reports their own room with reporter_guest_session_id set and a guest audit entry', async () => {
    const report = await createReport(db, guest1.as, { targetType: 'room', targetId: roomId, reason: 'hate', details: 'slurs' })
    expect(report).toMatchObject({ status: 'open', targetType: 'room', targetId: roomId, reason: 'hate', severity: 'normal', details: 'slurs' })
    expect(await reportRow(db, report.id)).toMatchObject({
      reporter_kind: 'guest',
      reporter_human_id: null,
      reporter_guest_session_id: session1,
      target_type: 'room',
      target_id: roomId,
    })
    const audit = await auditRows(db, 'report_create', roomId)
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ actor_role: 'guest', actor_human_id: null, actor_auth_user_id: guest1.userId, target_type: 'room', details: { reportId: report.id, reason: 'hate' } })
  })

  it('a Guest reports the Human participants of their room, not other Humans', async () => {
    const report = await createReport(db, guest1.as, { targetType: 'human', targetId: cohost.humanId, reason: 'threats' })
    expect(report).toMatchObject({ targetType: 'human', targetId: cohost.humanId, severity: 'high' })
    expect((await reportRow(db, report.id))?.reporter_guest_session_id).toBe(session1)
    expect((await createReport(db, guest1.as, { targetType: 'human', targetId: host.humanId })).targetId).toBe(host.humanId)
    expect(await reportErrorCode(db, guest1.as, { targetType: 'human', targetId: stranger.humanId })).toBe('not_visible')
    expect(await reportErrorCode(db, guest1.as, { targetType: 'human', targetId: randomUUID() })).toBe('not_visible')
  })

  it('a Guest reports another Guest of their room, never themself, never a Guest elsewhere', async () => {
    const report = await createReport(db, guest1.as, { targetType: 'guest', targetId: session2, reason: 'sexual_content' })
    expect(report).toMatchObject({ targetType: 'guest', targetId: session2 })
    expect(await reportErrorCode(db, guest1.as, { targetType: 'guest', targetId: session1 })).toBe('invalid_input')
    expect(await reportErrorCode(db, guest1.as, { targetType: 'guest', targetId: session3 })).toBe('not_visible')
    expect(await reportErrorCode(db, guest3.as, { targetType: 'guest', targetId: session1 })).toBe('not_visible')
  })

  it('a Guest cannot report a room they are not in', async () => {
    expect(await reportErrorCode(db, guest1.as, { targetType: 'room', targetId: otherRoomId })).toBe('not_visible')
    expect(await reportErrorCode(db, guest3.as, { targetType: 'room', targetId: roomId })).toBe('not_visible')
    expect(await reportErrorCode(db, guest1.as, { targetType: 'room', targetId: randomUUID() })).toBe('not_visible')
    // An anonymous credential without any session is a Guest with no room at all.
    expect(await reportErrorCode(db, (await createGuest(db)).as, { targetType: 'room', targetId: roomId })).toBe('not_visible')
  })

  it('a Guest may not report posts, messages or groups, even real and public ones', async () => {
    const post = await createPost(db, host, { audience: 'world', text: 'public' })
    expect(await reportErrorCode(db, guest1.as, { targetType: 'post', targetId: post.post.id })).toBe('guest_not_allowed')
    const dm = await directConversation(db, host, cohost)
    const message = await sendMessage(db, host, dm, 'hi')
    expect(await reportErrorCode(db, guest1.as, { targetType: 'message', targetId: message })).toBe('guest_not_allowed')
    const group = await db.rpc<{ id: string }>('group_create', { name: 'Crew' }, host.as)
    expect(await reportErrorCode(db, guest1.as, { targetType: 'group', targetId: group.id })).toBe('guest_not_allowed')
    expect(await reportErrorCode(db, guest1.as, { targetType: 'planet', targetId: roomId })).toBe('invalid_input')
  })

  it('a removed or expired Guest session cannot report any more', async () => {
    const invite = await createRoomInvite(db, roomId, host)
    const removed = await createGuest(db)
    const removedSession = await createGuestSession(db, removed, invite.token, 'Removed')
    expect((await createReport(db, removed.as, { targetType: 'room', targetId: roomId })).targetId).toBe(roomId)
    const view = await getRoom(db, roomId, host.as)
    const participant = view.participants.find((p) => p.guestSessionId === removedSession.guestSessionId)
    expect(participant).toBeDefined()
    await db.rpc('room_remove_participant', { room_id: roomId, participant_id: participant?.id, block_from_room: false }, host.as)
    expect(await reportErrorCode(db, removed.as, { targetType: 'room', targetId: roomId })).toBe('not_visible')
    expect(await reportErrorCode(db, removed.as, { targetType: 'human', targetId: host.humanId })).toBe('not_visible')

    const expired = await createGuest(db)
    const expiredSession = await createGuestSession(db, expired, invite.token, 'Expired')
    await db.sql.query(`update public.guest_sessions set created_at = now() - interval '1 hour', expires_at = now() - interval '1 second' where id = $1`, [expiredSession.guestSessionId])
    expect(await reportErrorCode(db, expired.as, { targetType: 'room', targetId: roomId })).toBe('not_visible')
    expect(await reportErrorCode(db, expired.as, { targetType: 'guest', targetId: session1 })).toBe('not_visible')
  })

  it('a Guest keeps reporting after a participant has left (the seat is history) but Humans of the room only', async () => {
    await db.rpc('room_leave', { room_id: roomId }, cohost.as)
    expect((await createReport(db, guest1.as, { targetType: 'human', targetId: cohost.humanId })).targetId).toBe(cohost.humanId)
  })

  it('Guests have no report history RPC and the service is not a Guest', async () => {
    expect(await errorCode(db.rpc('reports_mine', {}, guest1.as))).toBe('not_a_human')
    expect(await errorCode(db.rpc('blocks_list', {}, guest1.as))).toBe('not_a_human')
    expect(await errorCode(myReports(db, 'service'))).toBe('not_a_human')
  })

  it('a Guest reads their own report rows and nobody else\'s', async () => {
    const mine = await db.asRole(guest1.as, (c) => c.query<{ target_type: string }>('select target_type from public.reports order by created_at'))
    expect(mine.rows.length).toBeGreaterThanOrEqual(4)
    expect(mine.rows.map((r) => r.target_type)).toEqual(expect.arrayContaining(['room', 'human', 'guest']))
    const theirs = await db.asRole(guest2.as, (c) => c.query('select id from public.reports'))
    expect(theirs.rowCount).toBe(0)
    const guest3Rows = await db.asRole(guest3.as, (c) => c.query('select id from public.reports'))
    expect(guest3Rows.rowCount).toBe(0)
  })

  it('a Human reports a Guest of a room they can see; a Human who cannot see the room gets not_visible', async () => {
    const report = await createReport(db, host.as, { targetType: 'guest', targetId: session1, reason: 'spam_scam' })
    expect(report).toMatchObject({ targetType: 'guest', targetId: session1 })
    expect((await reportRow(db, report.id))?.reporter_human_id).toBe(host.humanId)
    expect(await reportErrorCode(db, stranger.as, { targetType: 'guest', targetId: session1 })).toBe('not_visible')
    expect(await reportErrorCode(db, host.as, { targetType: 'guest', targetId: session3 })).toBe('not_visible')
  })

  it('Guests get the stricter budget: 5 reports per hour, then rate_limited, reset by the service', async () => {
    const at = secondsFromNow(0)
    const args = { target_type: 'room', target_id: roomId, reason: 'other', details: null }
    await resetRateLimitsFor(db, guest2.userId)
    for (let i = 0; i < 5; i += 1) await rpcAt(db, 'report_create', args, guest2.as, at)
    expect(await errorCode(rpcAt(db, 'report_create', args, guest2.as, at))).toBe('rate_limited')
    expect(await resetRateLimitsFor(db, guest2.userId, 'report_create')).toBe(1)
    await rpcAt(db, 'report_create', args, guest2.as, at)
    // The window is keyed by the Guest credential: another Guest of the same room is unaffected.
    await rpcAt(db, 'report_create', { ...args, target_id: otherRoomId }, guest3.as, at)
  })
})
