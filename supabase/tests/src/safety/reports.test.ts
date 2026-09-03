/**
 * Reports (spec §41, §81–§82; DB_API §7): the domain mirrors (reasons, target types, severity),
 * `report_create` for Humans — every target type, existence + visibility, self-targets, input
 * validation, audit —, `reports_mine`, `blocks_list`, the service-only `report_resolve`, the
 * 20/h rate limit and the row invariants of 0700.
 */
import { REPORT_REASON, REPORT_REASON_HIGH_SEVERITY, REPORT_STATUS, REPORT_TARGET_TYPES, ReportDtoSchema } from '@earth/domain'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type TestDb } from '../harness'
import {
  addMember,
  auditRows,
  befriend,
  block,
  blocksList,
  createGroup,
  createGuest,
  createGuestSession,
  createHuman,
  createPost,
  createReport,
  createRoomInvite,
  createUnclaimed,
  directConversation,
  errorCode,
  getRoom,
  human,
  isPermissionDenied,
  myReports,
  reportErrorCode,
  reportRow,
  resetRateLimitsFor,
  resolveReport,
  rpcAt,
  secondsFromNow,
  sendMessage,
  startGroupRoom,
  startStandaloneRoom,
  type GroupFixture,
  type Human,
} from './fixtures'

describe('reports (DB_API §7)', () => {
  let db: TestDb
  let alice: Human
  let bob: Human
  let carol: Human
  let crew: GroupFixture

  beforeAll(async () => {
    db = await createTestDb()
    alice = await human(db, 'Alice')
    bob = await human(db, 'Bob')
    carol = await human(db, 'Carol')
    await befriend(db, alice, carol)
    crew = await createGroup(db, alice, 'Weekend Crew')
    await addMember(db, crew, carol)
  })

  afterAll(async () => {
    await db.drop()
  })

  describe('domain parity (packages/domain/src/enums.ts)', () => {
    it('earth.report_target_types() is exactly REPORT_TARGET_TYPES', async () => {
      const { rows } = await db.sql.query<{ types: string[] }>('select earth.report_target_types() as types')
      expect(rows[0]?.types).toEqual([...REPORT_TARGET_TYPES])
    })

    it('earth.report_high_severity_reasons() is exactly REPORT_REASON_HIGH_SEVERITY', async () => {
      const { rows } = await db.sql.query<{ reasons: string[] }>('select earth.report_high_severity_reasons()::text[] as reasons')
      expect([...(rows[0]?.reasons ?? [])].sort()).toEqual([...REPORT_REASON_HIGH_SEVERITY].sort())
      for (const reason of REPORT_REASON_HIGH_SEVERITY) expect(REPORT_REASON).toContain(reason)
    })

    it('the reason and status columns use the report_reason / report_status enum types', async () => {
      const { rows } = await db.sql.query<{ column_name: string; udt_name: string; data_type: string }>(
        `select column_name, udt_name, data_type from information_schema.columns
          where table_schema = 'public' and table_name = 'reports' and column_name in ('reason', 'status', 'severity', 'target_type')
          order by column_name`,
      )
      expect(rows).toEqual([
        { column_name: 'reason', udt_name: 'report_reason', data_type: 'USER-DEFINED' },
        { column_name: 'severity', udt_name: 'text', data_type: 'text' },
        { column_name: 'status', udt_name: 'report_status', data_type: 'USER-DEFINED' },
        { column_name: 'target_type', udt_name: 'text', data_type: 'text' },
      ])
      const { rows: labels } = await db.sql.query<{ labels: string[] }>(
        `select enum_range(null::public.report_status)::text[] as labels`,
      )
      expect(labels[0]?.labels).toEqual([...REPORT_STATUS])
    })

    it.each([...REPORT_REASON])('severity of %s is derived from REPORT_REASON_HIGH_SEVERITY', async (reason) => {
      const expected = REPORT_REASON_HIGH_SEVERITY.has(reason) ? 'high' : 'normal'
      const { rows } = await db.sql.query<{ severity: string }>('select earth.report_severity($1::public.report_reason) as severity', [reason])
      expect(rows[0]?.severity).toBe(expected)
      // The generated column agrees with the function.
      await db.sql.query('begin')
      try {
        const inserted = await db.sql.query<{ severity: string }>(
          `insert into public.reports (reporter_kind, reporter_human_id, target_type, target_id, reason)
           values ('human', $1, 'human', $2, $3::public.report_reason) returning severity`,
          [alice.humanId, bob.humanId, reason],
        )
        expect(inserted.rows[0]?.severity).toBe(expected)
      } finally {
        await db.sql.query('rollback')
      }
    })

    it.each([...REPORT_TARGET_TYPES])('target_type %s is accepted by the check constraint', async (targetType) => {
      await db.sql.query('begin')
      try {
        const { rows } = await db.sql.query<{ id: string }>(
          `insert into public.reports (reporter_kind, reporter_human_id, target_type, target_id, reason)
           values ('human', $1, $2, gen_random_uuid(), 'other') returning id`,
          [alice.humanId, targetType],
        )
        expect(rows[0]?.id).toBeDefined()
      } finally {
        await db.sql.query('rollback')
      }
    })

    it('a target_type outside the domain list is refused', async () => {
      let failure: unknown
      try {
        await db.sql.query(
          `insert into public.reports (reporter_kind, reporter_human_id, target_type, target_id, reason)
           values ('human', $1, 'planet', gen_random_uuid(), 'other')`,
          [alice.humanId],
        )
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(pg.DatabaseError)
      expect((failure as pg.DatabaseError).code).toBe('23514')
      expect((failure as pg.DatabaseError).constraint).toBe('reports_target_type_check')
    })
  })

  describe('report_create as a Human', () => {
    it('reports a visible Human: ReportDto, row, audit entry', async () => {
      const report = await createReport(db, alice.as, { targetType: 'human', targetId: bob.humanId, reason: 'harassment', details: '  keeps messaging me  ' })
      expect(ReportDtoSchema.parse(report)).toEqual({ id: report.id, status: 'open', createdAt: report.createdAt })
      expect(report).toMatchObject({ targetType: 'human', targetId: bob.humanId, reason: 'harassment', details: 'keeps messaging me', severity: 'normal', resolvedAt: null })
      expect(await reportRow(db, report.id)).toMatchObject({
        reporter_kind: 'human',
        reporter_human_id: alice.humanId,
        reporter_guest_session_id: null,
        target_type: 'human',
        target_id: bob.humanId,
        status: 'open',
        severity: 'normal',
        resolved_at: null,
      })
      const audit = await auditRows(db, 'report_create', bob.humanId)
      expect(audit).toHaveLength(1)
      expect(audit[0]).toMatchObject({
        actor_human_id: alice.humanId,
        actor_role: 'human',
        actor_auth_user_id: alice.userId,
        target_type: 'human',
        details: { reportId: report.id, reason: 'harassment', severity: 'normal' },
      })
    })

    it('high-severity reasons are stored as severity high', async () => {
      const report = await createReport(db, alice.as, { targetType: 'human', targetId: bob.humanId, reason: 'threats' })
      expect(report.severity).toBe('high')
      expect((await auditRows(db, 'report_create', bob.humanId)).at(-1)?.details).toMatchObject({ severity: 'high' })
    })

    it('rejects visitors, claiming Humans, the service and inactive Humans', async () => {
      const args = { targetType: 'human', targetId: bob.humanId } as const
      expect(await reportErrorCode(db, 'visitor', args)).toBe('not_authenticated')
      expect(await reportErrorCode(db, (await createUnclaimed(db)).as, args)).toBe('not_a_human')
      const pending = await createHuman(db, { handle: 'pendingreporter', status: 'pending' })
      expect(await reportErrorCode(db, pending.as, args)).toBe('not_a_human')
      expect(await reportErrorCode(db, 'service', args)).toBe('not_a_human')
      const suspended = await createHuman(db, { handle: 'suspendedreporter', status: 'suspended' })
      expect(await reportErrorCode(db, suspended.as, args)).toBe('human_not_active')
    })

    it('validates the input', async () => {
      expect(await reportErrorCode(db, alice.as, { targetType: 'planet', targetId: bob.humanId })).toBe('invalid_input')
      expect(await reportErrorCode(db, alice.as, { targetType: 'human', targetId: null })).toBe('invalid_input')
      expect(await reportErrorCode(db, alice.as, { targetType: 'human', targetId: bob.humanId, details: 'x'.repeat(2001) })).toBe('invalid_input')
      const long = await createReport(db, alice.as, { targetType: 'human', targetId: bob.humanId, details: 'y'.repeat(2000) })
      expect(long.details).toHaveLength(2000)
      const blank = await createReport(db, alice.as, { targetType: 'human', targetId: bob.humanId, details: '   ' })
      expect(blank.details).toBeNull()
      // An enum literal outside report_reason never reaches the RPC (cast failure, not P0001).
      let failure: unknown
      try {
        await db.rpc('report_create', { target_type: 'human', target_id: bob.humanId, reason: 'meh', details: null }, alice.as)
      } catch (error) {
        failure = error
      }
      expect((failure as pg.DatabaseError).code).toBe('22P02')
    })

    it('never reports yourself or your own content', async () => {
      expect(await reportErrorCode(db, alice.as, { targetType: 'human', targetId: alice.humanId })).toBe('invalid_input')
      const own = await createPost(db, alice, { audience: 'world', text: 'mine' })
      expect(await reportErrorCode(db, alice.as, { targetType: 'post', targetId: own.post.id })).toBe('invalid_input')
      const dm = await directConversation(db, alice, carol)
      const mine = await sendMessage(db, alice, dm, 'hello carol')
      expect(await reportErrorCode(db, alice.as, { targetType: 'message', targetId: mine })).toBe('invalid_input')
    })

    describe('Human targets', () => {
      it('unknown, pending or invisible Humans are not_visible', async () => {
        expect(await reportErrorCode(db, alice.as, { targetType: 'human', targetId: randomUUID() })).toBe('not_visible')
        const pending = await createHuman(db, { handle: 'pendingtarget', status: 'pending' })
        expect(await reportErrorCode(db, alice.as, { targetType: 'human', targetId: pending.humanId })).toBe('not_visible')
        const hidden = await createHuman(db, { handle: 'hiddenstranger', visibility: 'hidden' })
        expect(await reportErrorCode(db, alice.as, { targetType: 'human', targetId: hidden.humanId })).toBe('not_visible')
      })

      it('a hidden Human becomes reportable through a shared group, a conversation or a room', async () => {
        const hiddenMate = await createHuman(db, { handle: 'hiddenmate', visibility: 'hidden' })
        expect(await reportErrorCode(db, alice.as, { targetType: 'human', targetId: hiddenMate.humanId })).toBe('not_visible')
        await addMember(db, crew, hiddenMate)
        expect((await createReport(db, alice.as, { targetType: 'human', targetId: hiddenMate.humanId })).targetId).toBe(hiddenMate.humanId)

        const hiddenChat = await createHuman(db, { handle: 'hiddenchat', visibility: 'hidden' })
        await db.sql.query(
          `insert into public.conversations (type, direct_key) values ('direct', earth.direct_key($1, $2))`,
          [alice.humanId, hiddenChat.humanId],
        )
        await db.sql.query(
          `insert into public.conversation_members (conversation_id, human_id)
           select c.id, h from public.conversations c, unnest(array[$1::uuid, $2::uuid]) h where c.direct_key = earth.direct_key($1, $2)`,
          [alice.humanId, hiddenChat.humanId],
        )
        expect((await createReport(db, alice.as, { targetType: 'human', targetId: hiddenChat.humanId })).targetId).toBe(hiddenChat.humanId)

        const hiddenRoomie = await createHuman(db, { handle: 'hiddenroomie', visibility: 'hidden' })
        await befriend(db, hiddenRoomie, carol)
        const room = await startStandaloneRoom(db, hiddenRoomie)
        await db.sql.query(
          `insert into public.room_participants (room_id, human_id, status, media_state, left_at) values ($1, $2, 'left', 'watching', now())`,
          [room.room.id, alice.humanId],
        )
        expect((await createReport(db, alice.as, { targetType: 'human', targetId: hiddenRoomie.humanId })).targetId).toBe(hiddenRoomie.humanId)
      })

      it('a Human you blocked stays reportable; one who blocked you without any shared context does not', async () => {
        const blockedByAlice = await human(db, 'BlockedByAlice')
        await block(db, alice, blockedByAlice)
        expect((await createReport(db, alice.as, { targetType: 'human', targetId: blockedByAlice.humanId })).targetId).toBe(blockedByAlice.humanId)

        const blocker = await human(db, 'Blocker')
        await block(db, blocker, alice)
        expect(await reportErrorCode(db, alice.as, { targetType: 'human', targetId: blocker.humanId })).toBe('not_visible')
        // ...but a blocker who still shares a group with the reporter is visible there.
        await addMember(db, crew, blocker)
        expect((await createReport(db, alice.as, { targetType: 'human', targetId: blocker.humanId })).targetId).toBe(blocker.humanId)
      })
    })

    describe('post targets', () => {
      it('follows earth.can_view_post', async () => {
        const friendsOnly = await createPost(db, bob, { audience: 'friends', text: 'friends of bob' })
        expect(await reportErrorCode(db, alice.as, { targetType: 'post', targetId: friendsOnly.post.id })).toBe('not_visible')
        expect((await createReport(db, carol.as, { targetType: 'post', targetId: (await createPost(db, alice, { audience: 'friends', text: 'friends of alice' })).post.id })).targetType).toBe('post')

        const world = await createPost(db, bob, { audience: 'world', text: 'hello world' })
        const report = await createReport(db, alice.as, { targetType: 'post', targetId: world.post.id, reason: 'spam_scam' })
        expect(report).toMatchObject({ targetType: 'post', targetId: world.post.id, severity: 'normal' })
        expect((await auditRows(db, 'report_create', world.post.id))[0]).toMatchObject({ target_type: 'post', actor_human_id: alice.humanId })

        await db.rpc('post_delete', { post_id: world.post.id }, bob.as)
        expect(await reportErrorCode(db, alice.as, { targetType: 'post', targetId: world.post.id })).toBe('not_visible')
        expect(await reportErrorCode(db, alice.as, { targetType: 'post', targetId: randomUUID() })).toBe('not_visible')
      })
    })

    describe('room targets', () => {
      it('follows earth.room_visible_to', async () => {
        const dave = await human(db, 'Dave')
        const others = await createGroup(db, dave, 'Others')
        const theirRoom = await startGroupRoom(db, dave, others)
        expect(await reportErrorCode(db, alice.as, { targetType: 'room', targetId: theirRoom.room.id })).toBe('not_visible')

        const ours = await startGroupRoom(db, carol, crew)
        const report = await createReport(db, alice.as, { targetType: 'room', targetId: ours.room.id, reason: 'violence' })
        expect(report).toMatchObject({ targetType: 'room', targetId: ours.room.id, severity: 'high' })

        await db.rpc('room_end', { room_id: theirRoom.room.id }, dave.as)
        expect(await reportErrorCode(db, alice.as, { targetType: 'room', targetId: theirRoom.room.id })).toBe('not_visible')
        expect(await reportErrorCode(db, alice.as, { targetType: 'room', targetId: randomUUID() })).toBe('not_visible')
        await db.rpc('room_end', { room_id: ours.room.id }, carol.as)
      })
    })

    describe('message targets', () => {
      it('follows earth.can_view_conversation', async () => {
        const dm = await directConversation(db, bob, alice)
        const fromBob = await sendMessage(db, bob, dm, 'hey alice')
        const report = await createReport(db, alice.as, { targetType: 'message', targetId: fromBob, reason: 'hate' })
        expect(report).toMatchObject({ targetType: 'message', targetId: fromBob })

        const dave = await human(db, 'DaveMsg')
        const theirDm = await directConversation(db, bob, dave)
        const private_ = await sendMessage(db, bob, theirDm, 'private')
        expect(await reportErrorCode(db, alice.as, { targetType: 'message', targetId: private_ })).toBe('not_visible')
        expect(await reportErrorCode(db, alice.as, { targetType: 'message', targetId: randomUUID() })).toBe('not_visible')

        // A message in a direct conversation that a block suppresses is no longer reportable through it...
        const eve = await human(db, 'Eve')
        const eveDm = await directConversation(db, eve, alice)
        const fromEve = await sendMessage(db, eve, eveDm, 'boo')
        await db.rpc('block_set', { target_human_id: alice.humanId }, eve.as)
        expect(await reportErrorCode(db, alice.as, { targetType: 'message', targetId: fromEve })).toBe('not_visible')
      })
    })

    describe('group targets', () => {
      it('members only', async () => {
        const report = await createReport(db, carol.as, { targetType: 'group', targetId: crew.groupId, reason: 'impersonation' })
        expect(report).toMatchObject({ targetType: 'group', targetId: crew.groupId })
        expect(await reportErrorCode(db, bob.as, { targetType: 'group', targetId: crew.groupId })).toBe('not_visible')
        expect(await reportErrorCode(db, bob.as, { targetType: 'group', targetId: randomUUID() })).toBe('not_visible')
      })
    })

    describe('guest targets', () => {
      it('guests of rooms the reporter can see', async () => {
        const host = await human(db, 'Host')
        await befriend(db, host, alice)
        const room = await startStandaloneRoom(db, host)
        const invite = await createRoomInvite(db, room.room.id, host)
        const guest = await createGuest(db)
        const session = await createGuestSession(db, guest, invite.token, 'Sam')
        const view = await getRoom(db, room.room.id, alice.as)
        expect(view.participants.map((p) => p.guestSessionId)).toContain(session.guestSessionId)

        const report = await createReport(db, alice.as, { targetType: 'guest', targetId: session.guestSessionId, reason: 'sexual_content' })
        expect(report).toMatchObject({ targetType: 'guest', targetId: session.guestSessionId })
        expect(await reportErrorCode(db, bob.as, { targetType: 'guest', targetId: session.guestSessionId })).toBe('not_visible')
        expect(await reportErrorCode(db, alice.as, { targetType: 'guest', targetId: randomUUID() })).toBe('not_visible')
        await db.rpc('room_end', { room_id: room.room.id }, host.as)
      })
    })
  })

  describe('reports_mine', () => {
    it('lists the caller\'s own reports newest first and nothing else', async () => {
      const reporter = await human(db, 'Reporter')
      expect(await myReports(db, reporter.as)).toEqual([])
      const first = await rpcAt(db, 'report_create', { target_type: 'human', target_id: bob.humanId, reason: 'spam_scam', details: null }, reporter.as, secondsFromNow(-120))
      const second = await createReport(db, reporter.as, { targetType: 'human', targetId: carol.humanId, reason: 'threats' })
      const mine = await myReports(db, reporter.as)
      expect(mine.map((r) => r.id)).toEqual([second.id, (first as { id: string }).id])
      expect(mine[0]).toMatchObject({ targetId: carol.humanId, reason: 'threats', severity: 'high', status: 'open' })
      expect((await myReports(db, bob.as)).map((r) => r.id)).not.toContain(second.id)
    })

    it('is for Humans only', async () => {
      expect(await errorCode(db.rpc('reports_mine', {}, 'visitor'))).toBe('not_authenticated')
      expect(await errorCode(db.rpc('reports_mine', {}, (await createGuest(db)).as))).toBe('not_a_human')
      expect(await errorCode(db.rpc('reports_mine', {}, (await createUnclaimed(db)).as))).toBe('not_a_human')
    })
  })

  describe('blocks_list', () => {
    it('returns BlocksListDto with the blocked identities, newest first', async () => {
      const blocker = await human(db, 'ListBlocker')
      const first = await createHuman(db, { handle: 'firstblocked', displayName: 'First', visibility: 'hidden' })
      const second = await human(db, 'SecondBlocked')
      expect(await blocksList(db, blocker.as)).toEqual({ blocks: [] })
      await rpcAt(db, 'block_set', { target_human_id: first.humanId, blocked: true }, blocker.as, secondsFromNow(-60))
      await db.sql.query('update public.blocks set created_at = now() - interval \'60 seconds\' where blocker_human_id = $1 and blocked_human_id = $2', [blocker.humanId, first.humanId])
      await db.rpc('block_set', { target_human_id: second.humanId }, blocker.as)

      const list = await blocksList(db, blocker.as)
      expect(list.blocks.map((b) => b.blockedHumanId)).toEqual([second.humanId, first.humanId])
      expect(list.blocks[0]).toMatchObject({ blockerHumanId: blocker.humanId, identity: { humanId: second.humanId, displayName: 'SecondBlocked', handle: second.handle } })
      // A hidden profile is still listed to the Human who blocked it (they need to undo it).
      expect(list.blocks[1]?.identity).toMatchObject({ humanId: first.humanId, displayName: 'First', profileVisibility: 'hidden' })
      // Being blocked is never listed.
      expect(await blocksList(db, second.as)).toEqual({ blocks: [] })
      await db.rpc('block_set', { target_human_id: second.humanId, blocked: false }, blocker.as)
      expect((await blocksList(db, blocker.as)).blocks.map((b) => b.blockedHumanId)).toEqual([first.humanId])
    })

    it('is for Humans only', async () => {
      expect(await errorCode(db.rpc('blocks_list', {}, 'visitor'))).toBe('not_authenticated')
      expect(await errorCode(db.rpc('blocks_list', {}, (await createGuest(db)).as))).toBe('not_a_human')
      expect(await errorCode(db.rpc('blocks_list', {}, 'service'))).toBe('not_a_human')
    })
  })

  describe('report_resolve (service only)', () => {
    it('moves a report through the queue and audits every step', async () => {
      const report = await createReport(db, alice.as, { targetType: 'human', targetId: bob.humanId, reason: 'other' })
      const inReview = await resolveReport(db, report.id, 'in_review')
      expect(inReview).toMatchObject({ id: report.id, status: 'in_review', resolvedAt: null })
      const resolved = await resolveReport(db, report.id, 'resolved')
      expect(resolved.status).toBe('resolved')
      expect(resolved.resolvedAt).not.toBeNull()
      expect(await reportRow(db, report.id)).toMatchObject({ status: 'resolved' })
      // Reopening clears the resolution; dismissing sets it again.
      expect(await resolveReport(db, report.id, 'open')).toMatchObject({ status: 'open', resolvedAt: null })
      const dismissed = await resolveReport(db, report.id, 'dismissed')
      expect(dismissed.status).toBe('dismissed')
      expect(dismissed.resolvedAt).not.toBeNull()
      const audit = await auditRows(db, 'report_resolve', report.id)
      expect(audit.map((a) => [a.details['previousStatus'], a.details['status']])).toEqual([
        ['open', 'in_review'],
        ['in_review', 'resolved'],
        ['resolved', 'open'],
        ['open', 'dismissed'],
      ])
      expect(audit[0]).toMatchObject({ actor_role: 'service', actor_human_id: null, target_type: 'report', details: { targetType: 'human', targetId: bob.humanId } })
      // The reporter sees the new status in their history.
      expect((await myReports(db, alice.as)).find((r) => r.id === report.id)?.status).toBe('dismissed')
    })

    it('unknown reports and missing arguments are refused', async () => {
      expect(await errorCode(db.rpc('report_resolve', { report_id: randomUUID(), status: 'resolved' }, 'service'))).toBe('not_visible')
      expect(await errorCode(db.rpc('report_resolve', { report_id: null, status: 'resolved' }, 'service'))).toBe('invalid_input')
    })

    it('clients cannot execute it, and the role check refuses them even when granted', async () => {
      const report = await createReport(db, alice.as, { targetType: 'human', targetId: bob.humanId })
      for (const as of ['visitor', alice.as, (await createGuest(db)).as] as const) {
        let failure: unknown
        try {
          await db.rpc('report_resolve', { report_id: report.id, status: 'resolved' }, as)
        } catch (error) {
          failure = error
        }
        expect(isPermissionDenied(failure), String(as)).toBe(true)
      }
      await db.sql.query('grant execute on function public.report_resolve(uuid, public.report_status) to anon, authenticated')
      try {
        expect(await errorCode(db.rpc('report_resolve', { report_id: report.id, status: 'resolved' }, alice.as))).toBe('forbidden')
        expect(await errorCode(db.rpc('report_resolve', { report_id: report.id, status: 'resolved' }, 'visitor'))).toBe('forbidden')
      } finally {
        await db.sql.query('revoke execute on function public.report_resolve(uuid, public.report_status) from anon, authenticated')
      }
      expect(await reportRow(db, report.id)).toMatchObject({ status: 'open' })
    })
  })

  describe('rate limit (spec §83: reports 20/h)', () => {
    it('allows 20 reports per hour per Human, then rate_limited; the window and the reset helper restore it', async () => {
      const spammer = await human(db, 'Spammer')
      const at = secondsFromNow(0)
      for (let i = 0; i < 20; i += 1) {
        await rpcAt(db, 'report_create', { target_type: 'human', target_id: bob.humanId, reason: 'spam_scam', details: null }, spammer.as, at)
      }
      expect(await errorCode(rpcAt(db, 'report_create', { target_type: 'human', target_id: bob.humanId, reason: 'spam_scam', details: null }, spammer.as, at))).toBe('rate_limited')
      // A refused attempt writes nothing.
      expect((await myReports(db, spammer.as)).length).toBe(20)
      // After the window the budget is back.
      const later = new Date(new Date(at).getTime() + 3601 * 1000).toISOString()
      await rpcAt(db, 'report_create', { target_type: 'human', target_id: bob.humanId, reason: 'spam_scam', details: null }, spammer.as, later)
      // The service can clear a subject's windows (0730).
      for (let i = 0; i < 19; i += 1) {
        await rpcAt(db, 'report_create', { target_type: 'human', target_id: bob.humanId, reason: 'spam_scam', details: null }, spammer.as, later)
      }
      expect(await errorCode(rpcAt(db, 'report_create', { target_type: 'human', target_id: bob.humanId, reason: 'spam_scam', details: null }, spammer.as, later))).toBe('rate_limited')
      expect(await resetRateLimitsFor(db, spammer.userId, 'report_create')).toBe(1)
      await rpcAt(db, 'report_create', { target_type: 'human', target_id: bob.humanId, reason: 'spam_scam', details: null }, spammer.as, later)
    })
  })

  describe('row invariants (0700)', () => {
    it('identity columns are immutable; status and details may change', async () => {
      const report = await createReport(db, alice.as, { targetType: 'human', targetId: bob.humanId })
      for (const sql of [
        `update public.reports set target_id = gen_random_uuid() where id = $1`,
        `update public.reports set target_type = 'post' where id = $1`,
        `update public.reports set reason = 'violence' where id = $1`,
        `update public.reports set reporter_kind = 'guest', reporter_human_id = null where id = $1`,
        `update public.reports set reporter_human_id = '${carol.humanId}' where id = $1`,
        `update public.reports set created_at = now() - interval '1 day' where id = $1`,
      ]) {
        let failure: unknown
        try {
          await db.sql.query(sql, [report.id])
        } catch (error) {
          failure = error
        }
        expect(failure, sql).toBeInstanceOf(pg.DatabaseError)
        expect((failure as pg.DatabaseError).message, sql).toBe('invalid_input')
      }
      await db.sql.query(`update public.reports set details = 'edited by moderation' where id = $1`, [report.id])
      expect((await reportRow(db, report.id))?.details).toBe('edited by moderation')
    })

    it('a resolved status always carries resolved_at and vice versa; exactly one reporter kind', async () => {
      for (const sql of [
        `insert into public.reports (reporter_kind, reporter_human_id, target_type, target_id, reason, status) values ('human', '${alice.humanId}', 'human', '${bob.humanId}', 'other', 'resolved')`,
        `insert into public.reports (reporter_kind, reporter_human_id, target_type, target_id, reason, resolved_at) values ('human', '${alice.humanId}', 'human', '${bob.humanId}', 'other', now())`,
        `insert into public.reports (reporter_kind, reporter_human_id, reporter_guest_session_id, target_type, target_id, reason) values ('human', '${alice.humanId}', gen_random_uuid(), 'human', '${bob.humanId}', 'other')`,
        `insert into public.reports (reporter_kind, target_type, target_id, reason) values ('visitor', 'human', '${bob.humanId}', 'other')`,
        `insert into public.reports (reporter_kind, reporter_human_id, target_type, target_id, reason, details) values ('human', '${alice.humanId}', 'human', '${bob.humanId}', 'other', '')`,
      ]) {
        let failure: unknown
        try {
          await db.sql.query(sql)
        } catch (error) {
          failure = error
        }
        expect(failure, sql).toBeInstanceOf(pg.DatabaseError)
        expect((failure as pg.DatabaseError).code, sql).toBe('23514')
      }
    })

    it('a report survives its reporter: the reference is cleared, the kind is kept', async () => {
      const throwaway = await human(db, 'Throwaway')
      const report = await createReport(db, throwaway.as, { targetType: 'human', targetId: bob.humanId })
      await db.sql.query('delete from public.humans where id = $1', [throwaway.humanId])
      expect(await reportRow(db, report.id)).toMatchObject({ reporter_kind: 'human', reporter_human_id: null, reporter_guest_session_id: null, target_id: bob.humanId })
    })

    it('every foreign key and query path has an index', async () => {
      const { rows } = await db.sql.query<{ indexdef: string }>(`select indexdef from pg_indexes where schemaname = 'public' and tablename = 'reports'`)
      const defs = rows.map((r) => r.indexdef)
      for (const column of ['reporter_human_id', 'reporter_guest_session_id', 'target_type, target_id', 'status, severity, created_at']) {
        expect(defs.some((d) => d.includes(`(${column}`)), column).toBe(true)
      }
      expect(await db.sql.query(`select relrowsecurity from pg_class where oid = 'public.reports'::regclass`).then((r) => r.rows[0]?.relrowsecurity)).toBe(true)
    })
  })
})
