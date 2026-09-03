/**
 * Push queue and presence-aware dispatch (ARCHITECTURE §6 `/api/internal/push/dispatch`, §11;
 * spec §12; DB_API §6; 0600): `notifications_unsent` hands the dispatcher the oldest unsent rows
 * with the recipient's tokens and presence, excluding recipients who are looking at the very
 * conversation right now; `notifications_mark_pushed` sets `push_sent_at` exactly once;
 * `notifications_prune` enforces retention. All three are service-only.
 */
import { PRESENCE_ACTIVE_WINDOW_SECONDS } from '@earth/domain'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  PERMISSION_DENIED,
  count,
  createGuest,
  createHuman,
  directConversation,
  insertNotification,
  pushSentAt,
  registerPushToken,
  scalar,
  secondsFromNow,
  sendMessage,
  setPresence,
  unsent,
  type Human,
  type UnsentRow,
} from './fixtures'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function expectRowShape(row: UnsentRow): void {
  expect(row.id).toMatch(UUID)
  expect(row.recipientHumanId).toMatch(UUID)
  expect(typeof row.type).toBe('string')
  expect(['critical_social', 'high', 'normal', 'low']).toContain(row.priority)
  expect(row.actorHumanId === null || UUID.test(row.actorHumanId)).toBe(true)
  expect(['human', 'group', 'conversation', 'message', 'room', 'post']).toContain(row.objectType)
  expect(row.objectId).toMatch(UUID)
  expect(typeof row.payload).toBe('object')
  expect(Number.isNaN(Date.parse(row.createdAt))).toBe(false)
  expect(Array.isArray(row.pushTokens)).toBe(true)
  for (const token of row.pushTokens) {
    expect(token.token.length).toBeGreaterThan(0)
    expect(['ios', 'android', 'web']).toContain(token.platform)
  }
  if (row.presence !== null) {
    expect(Number.isNaN(Date.parse(row.presence.lastActiveAt))).toBe(false)
    expect(row.presence.activeConversationId === null || UUID.test(row.presence.activeConversationId)).toBe(true)
    expect(row.presence.activeRoomId === null || UUID.test(row.presence.activeRoomId)).toBe(true)
  }
}

describe('push queue (ARCHITECTURE §11; DB_API §6)', () => {
  let db: TestDb
  let alice: Human
  let bob: Human
  let carol: Human
  let dave: Human
  let erin: Human
  let guest: { userId: string; as: RoleSpec }
  let convBob: string
  let convCarol: string
  let convDave: string
  let convErin: string

  beforeAll(async () => {
    db = await createTestDb()
    alice = await createHuman(db, { handle: 'alice', displayName: 'Alice' })
    bob = await createHuman(db, { handle: 'bob', displayName: 'Bob' })
    carol = await createHuman(db, { handle: 'carol', displayName: 'Carol' })
    dave = await createHuman(db, { handle: 'dave', displayName: 'Dave' })
    erin = await createHuman(db, { handle: 'erin', displayName: 'Erin' })
    guest = await createGuest(db)
    await registerPushToken(db, bob, 'ExponentPushToken[bob-ios]', 'ios')
    await registerPushToken(db, bob, 'ExponentPushToken[bob-android]', 'android')
    await registerPushToken(db, carol, 'ExponentPushToken[carol-web]', 'web')
    await registerPushToken(db, erin, 'ExponentPushToken[erin-ios]', 'ios')
    convBob = await directConversation(db, alice, bob)
    convCarol = await directConversation(db, alice, carol)
    convDave = await directConversation(db, alice, dave)
    convErin = await directConversation(db, alice, erin)
  })

  beforeEach(async () => {
    await db.sql.query('delete from public.notifications')
    await db.sql.query('delete from public.human_presence')
    await db.sql.query('delete from private.rate_limits')
  })

  afterAll(async () => {
    await db.drop()
  })

  it('returns unsent rows oldest first with the recipient tokens and presence', async () => {
    const toBob = await sendMessage(db, alice, convBob, 'hey bob')
    const toCarol = await sendMessage(db, alice, convCarol, 'hey carol')
    const toDave = await sendMessage(db, alice, convDave, 'hey dave')
    const alreadyPushed = await insertNotification(db, { recipient: bob, type: 'follow', actor: alice, pushSentAt: new Date() })
    await setPresence(db, carol, { lastActiveAt: secondsFromNow(-5), activeConversationId: null, activeRoomId: null, platform: 'web' })

    const rows = await unsent(db)
    expect(rows.map((r) => r.objectId)).toEqual([toBob, toCarol, toDave])
    expect(rows.map((r) => r.id)).not.toContain(alreadyPushed)
    for (const row of rows) expectRowShape(row)

    const bobRow = rows[0]
    expect(bobRow).toMatchObject({
      recipientHumanId: bob.humanId,
      type: 'direct_message',
      priority: 'high',
      actorHumanId: alice.humanId,
      objectType: 'message',
      objectId: toBob,
      presence: null,
    })
    expect(bobRow?.payload).toEqual({ senderName: 'Alice', preview: 'hey bob', conversationId: convBob })
    expect(bobRow?.pushTokens).toEqual([
      { token: 'ExponentPushToken[bob-ios]', platform: 'ios' },
      { token: 'ExponentPushToken[bob-android]', platform: 'android' },
    ])
    expect(rows[1]?.pushTokens).toEqual([{ token: 'ExponentPushToken[carol-web]', platform: 'web' }])
    expect(rows[1]?.presence).toEqual({
      lastActiveAt: expect.any(String),
      activeConversationId: null,
      activeRoomId: null,
    })
    // No device: still returned (the dispatcher marks it handled); no presence row: null.
    expect(rows[2]).toMatchObject({ recipientHumanId: dave.humanId, pushTokens: [], presence: null })
    // Listing does not mark anything.
    for (const row of rows) expect(await pushSentAt(db, row.id)).toBeNull()
  })

  it('excludes recipients viewing the conversation within 30 s and includes idle ones', async () => {
    expect(PRESENCE_ACTIVE_WINDOW_SECONDS).toBe(30)
    const toBob = await sendMessage(db, alice, convBob, 'bob is reading this')
    const toCarol = await sendMessage(db, alice, convCarol, 'carol is elsewhere')
    const toDave = await sendMessage(db, alice, convDave, 'dave went idle')
    const toErin = await sendMessage(db, alice, convErin, 'erin has no presence')
    // A non-message notification for Bob is unaffected by what he is looking at.
    const bobFollow = await insertNotification(db, { recipient: bob, type: 'follow', actor: alice, payload: { name: 'Alice' } })
    await setPresence(db, bob, { lastActiveAt: secondsFromNow(-5), activeConversationId: convBob })
    await setPresence(db, carol, { lastActiveAt: secondsFromNow(-5), activeConversationId: convBob })
    await setPresence(db, dave, { lastActiveAt: secondsFromNow(-45), activeConversationId: convDave })

    const rows = await unsent(db)
    const byObject = new Map(rows.map((r) => [r.objectId, r]))
    expect(byObject.has(toBob)).toBe(false)
    expect(byObject.get(toCarol)?.recipientHumanId).toBe(carol.humanId)
    expect(byObject.get(toDave)?.recipientHumanId).toBe(dave.humanId)
    expect(byObject.get(toErin)?.recipientHumanId).toBe(erin.humanId)
    expect(rows.map((r) => r.id)).toContain(bobFollow)
    expect(byObject.get(toDave)?.presence).toMatchObject({ activeConversationId: convDave })

    // The suppressed row is handled: marked pushed, and never returned later, even once Bob leaves.
    const suppressed = await scalar<string>(db, 'id from public.notifications where object_id = $1', [toBob])
    expect(await pushSentAt(db, suppressed)).not.toBeNull()
    await setPresence(db, bob, { lastActiveAt: secondsFromNow(-120), activeConversationId: null })
    expect((await unsent(db)).map((r) => r.objectId)).not.toContain(toBob)
    // Nothing else was marked by listing.
    for (const row of rows) expect(await pushSentAt(db, row.id)).toBeNull()

    // Presence just outside the window in the same conversation → idle → included.
    await setPresence(db, bob, { lastActiveAt: secondsFromNow(-31), activeConversationId: convBob })
    const later = await sendMessage(db, alice, convBob, 'bob went idle')
    expect((await unsent(db)).map((r) => r.objectId)).toContain(later)
    // Back within the window → suppressed again.
    await setPresence(db, bob, { lastActiveAt: secondsFromNow(-1), activeConversationId: convBob })
    const again = await sendMessage(db, alice, convBob, 'bob is back')
    expect((await unsent(db)).map((r) => r.objectId)).not.toContain(again)
    expect(await pushSentAt(db, await scalar<string>(db, 'id from public.notifications where object_id = $1', [again]))).not.toBeNull()
  })

  it('a conversation object is matched by object id, and Live/social rows are never suppressed', async () => {
    const conversationRow = await insertNotification(db, {
      recipient: bob,
      type: 'group_message',
      actor: alice,
      objectType: 'conversation',
      objectId: convBob,
      payload: { groupName: 'Crew', senderName: 'Alice', preview: 'x' },
    })
    const live = await insertNotification(db, {
      recipient: bob,
      type: 'friend_live',
      actor: alice,
      objectType: 'room',
      objectId: '11111111-1111-4111-8111-111111111111',
      payload: { name: 'Alice', roomId: '11111111-1111-4111-8111-111111111111' },
    })
    const badConversation = await insertNotification(db, {
      recipient: bob,
      type: 'direct_message',
      actor: alice,
      objectType: 'message',
      objectId: '22222222-2222-4222-8222-222222222222',
      payload: { senderName: 'Alice', preview: 'x', conversationId: 'not-a-uuid' },
    })
    await setPresence(db, bob, { lastActiveAt: secondsFromNow(-2), activeConversationId: convBob, activeRoomId: '11111111-1111-4111-8111-111111111111' })
    const ids = (await unsent(db)).map((r) => r.id)
    expect(ids).not.toContain(conversationRow)
    expect(ids).toContain(live)
    expect(ids).toContain(badConversation)
  })

  it('limit takes the oldest rows and is clamped to 1..2000', async () => {
    const base = Date.parse('2026-09-01T10:00:00Z')
    const ids: string[] = []
    for (let i = 0; i < 5; i += 1) {
      ids.push(await insertNotification(db, { recipient: bob, type: 'follow', actor: alice, createdAt: new Date(base + i * 1000) }))
    }
    expect((await unsent(db, 2)).map((r) => r.id)).toEqual(ids.slice(0, 2))
    expect((await unsent(db, 0)).map((r) => r.id)).toEqual(ids.slice(0, 1))
    expect((await unsent(db, 100_000)).map((r) => r.id)).toEqual(ids)
    expect((await unsent(db)).map((r) => r.id)).toEqual(ids)
    // Suppressed rows count against the batch but are not returned.
    await setPresence(db, bob, { lastActiveAt: secondsFromNow(-1), activeConversationId: convBob })
    const suppressed = await insertNotification(db, {
      recipient: bob,
      type: 'direct_message',
      actor: alice,
      objectType: 'message',
      objectId: '33333333-3333-4333-8333-333333333333',
      payload: { senderName: 'Alice', preview: 'x', conversationId: convBob },
      createdAt: new Date(base - 1000),
    })
    expect((await unsent(db, 3)).map((r) => r.id)).toEqual(ids.slice(0, 2))
    expect(await pushSentAt(db, suppressed)).not.toBeNull()
  })

  it('notifications_mark_pushed sets push_sent_at once and never moves it', async () => {
    const a = await insertNotification(db, { recipient: bob, type: 'follow', actor: alice })
    const b = await insertNotification(db, { recipient: carol, type: 'follow', actor: alice })
    const c = await insertNotification(db, { recipient: dave, type: 'follow', actor: alice })
    expect(await db.rpc('notifications_mark_pushed', { ids: [a, b, a] }, 'service')).toEqual({ markedCount: 2 })
    const firstA = await pushSentAt(db, a)
    const firstB = await pushSentAt(db, b)
    expect(firstA).not.toBeNull()
    expect(firstB).not.toBeNull()
    expect(await pushSentAt(db, c)).toBeNull()
    expect((await unsent(db)).map((r) => r.id)).toEqual([c])
    // Idempotent and stable across time.
    await db.asRole('service', async (client) => {
      await client.query(`select set_config('earth.now', $1, true)`, [secondsFromNow(3600)])
      const { rows } = await client.query<{ r: { markedCount: number } }>(
        'select public.notifications_mark_pushed($1::uuid[]) as r',
        [[a, b, c, '00000000-0000-0000-0000-000000000000']],
      )
      expect(rows[0]?.r).toEqual({ markedCount: 1 })
    })
    expect(await pushSentAt(db, a)).toBe(firstA)
    expect(await pushSentAt(db, b)).toBe(firstB)
    expect(await pushSentAt(db, c)).not.toBeNull()
    expect(await db.rpc('notifications_mark_pushed', { ids: [] }, 'service')).toEqual({ markedCount: 0 })
    expect(await db.rpc('notifications_mark_pushed', { ids: null }, 'service')).toEqual({ markedCount: 0 })
    expect(await unsent(db)).toEqual([])
  })

  it('notifications_prune removes rows and cooldowns older than the retention window', async () => {
    const old = await insertNotification(db, { recipient: bob, type: 'follow', actor: alice, createdAt: secondsFromNow(-91 * 86_400), readAt: new Date(), pushSentAt: new Date() })
    const unreadOld = await insertNotification(db, { recipient: bob, type: 'follow', actor: alice, createdAt: secondsFromNow(-100 * 86_400) })
    const recent = await insertNotification(db, { recipient: bob, type: 'follow', actor: alice, createdAt: secondsFromNow(-89 * 86_400) })
    const room = '44444444-4444-4444-8444-444444444444'
    await db.sql.query(
      `insert into public.notification_cooldowns (recipient_human_id, room_id, last_sent_at)
       values ($1, $2, now() - interval '100 days'), ($3, $2, now() - interval '1 hour')`,
      [bob.humanId, room, carol.humanId],
    )
    await db.expectError(db.rpc('notifications_prune', { days: 0 }, 'service'), 'invalid_input')
    await db.expectError(db.rpc('notifications_prune', { days: null }, 'service'), 'invalid_input')
    expect(await db.rpc('notifications_prune', { days: 90 }, 'service')).toEqual({ deleted: 2, cooldownsDeleted: 1 })
    expect(await count(db, 'public.notifications', 'id = any($1::uuid[])', [[old, unreadOld]])).toBe(0)
    expect(await count(db, 'public.notifications', 'id = $1', [recent])).toBe(1)
    expect(await count(db, 'public.notification_cooldowns', 'room_id = $1', [room])).toBe(1)
    expect(await count(db, 'public.notification_cooldowns', 'recipient_human_id = $1', [carol.humanId])).toBe(1)
    // The default window is 90 days; pruning again is a no-op.
    expect(await db.rpc('notifications_prune', {}, 'service')).toEqual({ deleted: 0, cooldownsDeleted: 0 })
    expect(await db.rpc('notifications_prune', { days: 1 }, 'service')).toEqual({ deleted: 1, cooldownsDeleted: 0 })
    await db.sql.query('delete from public.notification_cooldowns')
  })

  it('the queue RPCs are executable by the service role only', async () => {
    const id = await insertNotification(db, { recipient: bob, type: 'follow', actor: alice })
    const calls: Array<[string, Record<string, unknown>]> = [
      ['notifications_unsent', { limit: 10 }],
      ['notifications_mark_pushed', { ids: [id] }],
      ['notifications_prune', { days: 90 }],
    ]
    for (const [name, args] of calls) {
      for (const as of ['visitor', guest.as, bob.as] as RoleSpec[]) {
        await expect(db.rpc(name, args, as), `${name} as ${JSON.stringify(as)}`).rejects.toSatisfy(
          (error: unknown) => error instanceof pg.DatabaseError && error.code === PERMISSION_DENIED,
        )
      }
      for (const role of ['anon', 'authenticated', 'public']) {
        expect(
          await scalar(db, 'has_function_privilege($1, $2, $3)', [role, `public.${name}(${name === 'notifications_mark_pushed' ? 'uuid[]' : 'integer'})`, 'EXECUTE']),
          `${role} ${name}`,
        ).toBe(false)
      }
      expect(
        await scalar(db, 'has_function_privilege($1, $2, $3)', ['service_role', `public.${name}(${name === 'notifications_mark_pushed' ? 'uuid[]' : 'integer'})`, 'EXECUTE']),
      ).toBe(true)
    }
    expect(await pushSentAt(db, id)).toBeNull()
    expect(await count(db, 'public.notifications')).toBe(1)
    // A superuser session without a JWT (migrations, cron over a direct connection) is the service.
    const { rows } = await db.sql.query<{ r: unknown[] }>('select public.notifications_unsent(10) as r')
    expect(rows[0]?.r).toHaveLength(1)
  })
})
