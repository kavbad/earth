/**
 * Reporting a participant of a room (spec §81 "Every Human profile: ... Report" / "Every Guest:
 * Remove, report, block session/device from room"; DB_API §7).
 *
 * These are exactly the calls the participants sheet of both clients makes: a Human seated in a
 * room reports another Human seated there (`target_type = 'human'`) or a Guest of that room
 * (`target_type = 'guest'`, the guest session id), and a Guest reports the Humans and Guests seated
 * with them. The room seat is the only thing the reporter and the target share — no friendship, no
 * group, no conversation — because that is the situation the control exists for: you are in a room
 * with someone you do not know. Nobody outside the room can use the same call to reach them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createGuest,
  createGuestSession,
  createHuman,
  createReport,
  createRoomInvite,
  getRoom,
  human,
  reportErrorCode,
  reportRow,
  startStandaloneRoom,
  type Guest,
  type Human,
} from './fixtures'
import { createTestDb, type TestDb } from '../harness'

describe('participant reports (spec §81)', () => {
  let db: TestDb
  let host: Human
  let peer: Human
  let outsider: Human
  let roomId: string
  let guestA: Guest
  let guestB: Guest
  let sessionA: string
  let sessionB: string
  let peerParticipantId: string
  let guestAParticipantId: string

  beforeAll(async () => {
    db = await createTestDb()
    // Hidden profiles: the seat in the room is then the only thing the two share, so the report
    // has to travel the shared-room branch of earth.human_reportable_by and nothing else.
    host = await createHuman(db, { handle: 'roomhost', displayName: 'Host', visibility: 'hidden' })
    peer = await createHuman(db, { handle: 'roompeer', displayName: 'Peer', visibility: 'hidden' })
    outsider = await human(db, 'Outsider')

    const room = await startStandaloneRoom(db, host, 'Kitchen')
    roomId = room.room.id

    // The Human peer arrives the way SCREEN 17 sends them: a room link, nothing else in common.
    const invite = await createRoomInvite(db, roomId, host)
    await db.rpc(
      'room_invite_join',
      { token: invite.token, media_state: 'camera', consent_level: 'friends' },
      peer.as,
    )

    guestA = await createGuest(db)
    guestB = await createGuest(db)
    sessionA = (await createGuestSession(db, guestA, invite.token, 'Sam')).guestSessionId
    sessionB = (await createGuestSession(db, guestB, invite.token, 'Pat')).guestSessionId

    const view = await getRoom(db, roomId, host.as)
    const peerRow = view.participants.find((p) => p.humanId === peer.humanId)
    const guestRow = view.participants.find((p) => p.guestSessionId === sessionA)
    if (peerRow === undefined || guestRow === undefined) {
      throw new Error('the room does not list the participants the report actions are drawn from')
    }
    peerParticipantId = peerRow.id
    guestAParticipantId = guestRow.id
  })

  afterAll(async () => {
    await db.drop()
  })

  it('the participants sheet lists everyone a report can be raised against', async () => {
    const view = await getRoom(db, roomId, peer.as)
    const others = view.participants.filter((p) => p.humanId !== peer.humanId)
    // Each row carries the id its Report action sends: humanId for a Human, guestSessionId for a Guest.
    for (const participant of others) {
      expect(
        participant.isGuest ? participant.guestSessionId : participant.humanId,
        participant.displayName,
      ).not.toBeNull()
    }
    expect(others.map((p) => p.isGuest).sort()).toEqual([false, true, true])
    expect(peerParticipantId).not.toBe(guestAParticipantId)
  })

  it('a Human reports another Human of their room, sharing nothing but the seat', async () => {
    // Neither can see the other anywhere else on Earth.
    expect(
      await reportErrorCode(db, outsider.as, { targetType: 'human', targetId: peer.humanId }),
    ).toBe('not_visible')
    const report = await createReport(db, peer.as, {
      targetType: 'human',
      targetId: host.humanId,
      reason: 'harassment',
    })
    expect(report).toMatchObject({ targetType: 'human', targetId: host.humanId, status: 'open' })
    expect(await reportRow(db, report.id)).toMatchObject({
      reporter_kind: 'human',
      reporter_human_id: peer.humanId,
      target_type: 'human',
      target_id: host.humanId,
    })
    // Both directions: the moderator is not the only one who may report.
    expect(
      (await createReport(db, host.as, { targetType: 'human', targetId: peer.humanId })).targetId,
    ).toBe(peer.humanId)
  })

  it('a Human reports a Guest of their room by guest session id, moderator or not', async () => {
    const byModerator = await createReport(db, host.as, {
      targetType: 'guest',
      targetId: sessionA,
      reason: 'spam_scam',
    })
    expect(byModerator).toMatchObject({ targetType: 'guest', targetId: sessionA })
    const byParticipant = await createReport(db, peer.as, {
      targetType: 'guest',
      targetId: sessionB,
      reason: 'hate',
    })
    expect(byParticipant).toMatchObject({ targetType: 'guest', targetId: sessionB })
    expect((await reportRow(db, byParticipant.id))?.reporter_human_id).toBe(peer.humanId)
  })

  it('a Guest reports the Humans and the Guests seated with them', async () => {
    const aboutHuman = await createReport(db, guestA.as, {
      targetType: 'human',
      targetId: peer.humanId,
      reason: 'threats',
    })
    expect(aboutHuman).toMatchObject({ targetType: 'human', targetId: peer.humanId })
    expect((await reportRow(db, aboutHuman.id))?.reporter_guest_session_id).toBe(sessionA)

    const aboutGuest = await createReport(db, guestA.as, {
      targetType: 'guest',
      targetId: sessionB,
      reason: 'harassment',
    })
    expect(aboutGuest).toMatchObject({ targetType: 'guest', targetId: sessionB })
    expect((await reportRow(db, aboutGuest.id))?.reporter_guest_session_id).toBe(sessionA)
  })

  it('nobody reports themself, and the room is not a way to reach people outside it', async () => {
    expect(
      await reportErrorCode(db, host.as, { targetType: 'human', targetId: host.humanId }),
    ).toBe('invalid_input')
    expect(await reportErrorCode(db, guestA.as, { targetType: 'guest', targetId: sessionA })).toBe(
      'invalid_input',
    )
    expect(
      await reportErrorCode(db, outsider.as, { targetType: 'human', targetId: host.humanId }),
    ).toBe('not_visible')
    expect(
      await reportErrorCode(db, outsider.as, { targetType: 'guest', targetId: sessionA }),
    ).toBe('not_visible')
  })
})
