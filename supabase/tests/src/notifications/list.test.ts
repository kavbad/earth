/**
 * Notification list and read state (SCREEN 23 "Priority ranking"; spec §40, §86; DB_API §6; 0600):
 * `notifications_list` orders by priority rank then recency with a stable keyset cursor and renders
 * the exact spec copy; `notification_mark_read` / `notifications_mark_all_read` /
 * `notifications_unread_count` maintain read state for the caller only.
 */
import {
  NOTIFICATION_PRIORITY,
  NOTIFICATION_PRIORITY_RANK,
  NOTIFICATION_TYPES,
  NotificationDtoSchema,
  notificationCopyFromPayload,
  type NotificationType,
} from '@earth/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  createGuest,
  createHuman,
  createUnclaimed,
  insertNotification,
  listAllNotifications,
  listNotifications,
  readAt,
  scalar,
  type Human,
} from './fixtures'

const BASE = Date.parse('2026-09-01T10:00:00Z')
const at = (seconds: number): string => new Date(BASE + seconds * 1000).toISOString()

describe('notifications_list ordering and pagination (SCREEN 23; DB_API §6)', () => {
  let db: TestDb
  let alice: Human
  let bob: Human
  let carol: Human
  /** Alice's rows keyed by letter; the expected order is documented in `EXPECTED`. */
  const ids: Record<string, string> = {}
  // critical_social first (newest first), then high, normal, low.
  const EXPECTED = ['G', 'D', 'H', 'E', 'B', 'C', 'F', 'A'] as const

  beforeAll(async () => {
    db = await createTestDb()
    alice = await createHuman(db, { handle: 'alice', displayName: 'Alice' })
    bob = await createHuman(db, { handle: 'bob', displayName: 'Bob' })
    carol = await createHuman(db, { handle: 'carol', displayName: 'Carol' })
    const rows: Array<[string, NotificationType, number, Record<string, unknown>]> = [
      ['A', 'follow', 1, { name: 'Bob' }],
      ['B', 'direct_message', 2, { senderName: 'Bob', preview: 'hi' }],
      ['C', 'group_message', 3, { groupName: 'Weekend Crew', senderName: 'Bob', preview: 'yo' }],
      ['D', 'friend_live', 4, { name: 'Bob', activity: 'Cooking dinner' }],
      ['E', 'friend_request', 5, { name: 'Bob' }],
      ['F', 'follow', 6, { name: 'Bob' }],
      ['G', 'multi_live', 7, { names: ['Bob', 'Carol'], total: 2 }],
      ['H', 'group_invitation', 8, { name: 'Bob', groupName: 'Weekend Crew' }],
    ]
    for (const [key, type, seconds, payload] of rows) {
      ids[key] = await insertNotification(db, {
        recipient: alice,
        type,
        actor: bob,
        payload,
        createdAt: at(seconds),
        readAt: key === 'H' ? at(9) : null,
      })
    }
    // Rows of other Humans never leak into Alice's list.
    await insertNotification(db, { recipient: bob, type: 'follow', actor: alice, createdAt: at(10) })
  })

  afterAll(async () => {
    await db.drop()
  })

  it('the priority enum is ordered exactly like NOTIFICATION_PRIORITY_RANK', async () => {
    const { rows } = await db.sql.query<{ label: string; rank: number }>(
      `select e.enumlabel as label, earth.notification_priority_rank(e.enumlabel::public.notification_priority) as rank
         from pg_enum e join pg_type t on t.oid = e.enumtypid
        where t.typname = 'notification_priority' order by e.enumsortorder`,
    )
    expect(rows.map((r) => r.label)).toEqual([...NOTIFICATION_PRIORITY])
    for (const row of rows) {
      expect(row.rank).toBe(NOTIFICATION_PRIORITY_RANK[row.label as keyof typeof NOTIFICATION_PRIORITY_RANK])
    }
    expect(rows.map((r) => r.rank)).toEqual([0, 1, 2, 3])
    // The list query path is indexed.
    expect(
      await scalar(
        db,
        `indexdef from pg_indexes where schemaname = 'public' and indexname = 'notifications_recipient_priority_created_idx'`,
      ),
    ).toContain('(recipient_human_id, priority, created_at DESC, id DESC)')
  })

  it('orders by priority rank (critical_social, high, normal, low) then created_at desc', async () => {
    const page = await listNotifications(db, alice.as, { limit: 100 })
    expect(page.notifications.map((n) => n.id)).toEqual(EXPECTED.map((k) => ids[k]))
    expect(page.nextCursor).toBeNull()
    expect(page.unreadCount).toBe(7)
    const g = page.notifications[0]
    expect(g).toMatchObject({
      type: 'multi_live',
      priority: 'critical_social',
      actorHumanId: bob.humanId,
      objectType: 'human',
      objectId: bob.humanId,
      readAt: null,
      title: 'Bob + Carol are live',
      body: 'Join them',
    })
    expect(page.notifications[2]?.readAt).not.toBeNull()
    for (const n of page.notifications) expect(NotificationDtoSchema.safeParse(n).success).toBe(true)
  })

  it('paginates stably with the (createdAt,id) keyset cursor', async () => {
    const first = await listNotifications(db, alice.as, { limit: 3 })
    expect(first.notifications.map((n) => n.id)).toEqual([ids['G'], ids['D'], ids['H']])
    expect(first.nextCursor).not.toBeNull()
    expect(first.nextCursor).toBe(`${first.notifications[2]?.createdAt},${ids['H']}`)
    const second = await listNotifications(db, alice.as, { cursor: first.nextCursor, limit: 3 })
    expect(second.notifications.map((n) => n.id)).toEqual([ids['E'], ids['B'], ids['C']])
    const third = await listNotifications(db, alice.as, { cursor: second.nextCursor, limit: 3 })
    expect(third.notifications.map((n) => n.id)).toEqual([ids['F'], ids['A']])
    expect(third.nextCursor).toBeNull()
    // Every page size walks the same sequence without duplicates or gaps.
    for (const limit of [1, 2, 3, 5, 8]) {
      expect((await listAllNotifications(db, alice.as, limit)).map((n) => n.id), `limit ${limit}`).toEqual(
        EXPECTED.map((k) => ids[k]),
      )
    }
    // An exact fit leaves no dangling cursor.
    const exact = await listNotifications(db, alice.as, { limit: 8 })
    expect(exact.notifications).toHaveLength(8)
    expect(exact.nextCursor).toBeNull()
  })

  it('rows arriving mid-pagination never duplicate or shift the rows already handed out', async () => {
    const first = await listNotifications(db, alice.as, { limit: 3 })
    // A newer critical row: it belongs before the cursor (rank already passed) and is skipped on the
    // continuation; a newer low row lands ahead of the older low rows when that rank is reached.
    const lateCritical = await insertNotification(db, { recipient: alice, type: 'friend_live', actor: carol, payload: { name: 'Carol' }, createdAt: at(20) })
    const lateLow = await insertNotification(db, { recipient: alice, type: 'follow', actor: carol, payload: { name: 'Carol' }, createdAt: at(21) })
    const rest: string[] = []
    let cursor = first.nextCursor
    while (cursor !== null) {
      const page = await listNotifications(db, alice.as, { cursor, limit: 3 })
      rest.push(...page.notifications.map((n) => n.id))
      cursor = page.nextCursor
    }
    expect(rest).toEqual([ids['E'], ids['B'], ids['C'], lateLow, ids['F'], ids['A']])
    expect(rest).not.toContain(lateCritical)
    // A fresh list starts with the new critical row.
    expect((await listNotifications(db, alice.as, { limit: 1 })).notifications[0]?.id).toBe(lateCritical)
    await db.sql.query('delete from public.notifications where id = any($1::uuid[])', [[lateCritical, lateLow]])
  })

  it('rejects malformed or foreign cursors with invalid_input', async () => {
    const first = await listNotifications(db, alice.as, { limit: 2 })
    const cursor = first.nextCursor
    expect(cursor).not.toBeNull()
    if (cursor === null) return
    for (const bad of ['garbage', 'x,y', `${ids['D']}`, `2026-09-01T10:00:04+00:00,not-a-uuid`, `nope,${ids['D']}`]) {
      await db.expectError(listNotifications(db, alice.as, { cursor: bad }), 'invalid_input')
    }
    // Another Human's cursor, or a cursor whose createdAt does not match the row.
    await db.expectError(listNotifications(db, bob.as, { cursor }), 'invalid_input')
    await db.expectError(
      listNotifications(db, alice.as, { cursor: `2020-01-01T00:00:00+00:00,${ids['D']}` }),
      'invalid_input',
    )
  })

  it('clamps limit to 1..100 and defaults to 30', async () => {
    expect((await listNotifications(db, alice.as, { limit: 0 })).notifications).toHaveLength(1)
    expect((await listNotifications(db, alice.as, { limit: -5 })).notifications).toHaveLength(1)
    expect((await listNotifications(db, alice.as, { limit: 1000 })).notifications).toHaveLength(8)
    expect((await listNotifications(db, alice.as, {})).notifications).toHaveLength(8)
    // 101 rows: the default page is 30 and the cap 100.
    for (let i = 0; i < 101; i += 1) {
      await insertNotification(db, { recipient: carol, type: 'follow', actor: bob, createdAt: at(100 + i) })
    }
    expect((await listNotifications(db, carol.as, {})).notifications).toHaveLength(30)
    const capped = await listNotifications(db, carol.as, { limit: 500 })
    expect(capped.notifications).toHaveLength(100)
    expect(capped.nextCursor).not.toBeNull()
    expect((await listAllNotifications(db, carol.as, 100)).length).toBe(101)
    await db.sql.query('delete from public.notifications where recipient_human_id = $1', [carol.humanId])
  })

  it('an empty list is a valid empty page', async () => {
    expect(await listNotifications(db, carol.as, {})).toEqual({ notifications: [], nextCursor: null, unreadCount: 0 })
  })
})

describe('notification copy (spec §86) and read state (DB_API §6)', () => {
  let db: TestDb
  let alice: Human
  let bob: Human
  let guest: { userId: string; as: RoleSpec }
  let claiming: Human
  let unclaimed: { userId: string; as: RoleSpec }
  let suspended: Human

  beforeAll(async () => {
    db = await createTestDb()
    alice = await createHuman(db, { handle: 'alice', displayName: 'Alice' })
    bob = await createHuman(db, { handle: 'bob', displayName: 'Bob' })
    guest = await createGuest(db)
    claiming = await createHuman(db, { handle: 'pend', status: 'pending' })
    unclaimed = await createUnclaimed(db)
    suspended = await createHuman(db, { handle: 'susp', status: 'suspended' })
  })

  afterAll(async () => {
    await db.drop()
  })

  it('renders title and body exactly like notificationCopyFromPayload for every type', async () => {
    const cases: Array<[NotificationType, Record<string, unknown>, string, string]> = [
      ['direct_message', { senderName: 'Xavier', preview: 'see you at 8?' }, 'Xavier', 'see you at 8?'],
      ['direct_message', { senderName: ' Xavier ' }, 'Xavier', ''],
      ['group_message', { groupName: 'Weekend Crew', senderName: 'Maya', preview: 'bringing snacks' }, 'Weekend Crew', 'Maya: bringing snacks'],
      ['friend_live', { name: 'Xavier', activity: 'Cooking dinner' }, 'Xavier is live', 'Cooking dinner'],
      ['friend_live', { name: 'Xavier' }, 'Xavier is live', 'Join them'],
      ['friend_live', { name: 'Xavier', activity: null }, 'Xavier is live', 'Join them'],
      ['friend_live', { name: 'Xavier', activity: '  ' }, 'Xavier is live', 'Join them'],
      ['multi_live', { names: ['Xavier', 'Maya'] }, 'Xavier + Maya are live', 'Join them'],
      ['multi_live', { names: ['Xavier', 'Maya', 'Sam', 'Ben'] }, 'Xavier, Maya + 2 are live', 'Join them'],
      ['multi_live', { names: ['Xavier'], total: 3 }, 'Xavier + 2 are live', 'Join them'],
      ['multi_live', { names: ['Xavier'] }, 'Xavier + 1 are live', 'Join them'],
      ['multi_live', { names: ['Xavier', ' Maya ', ''] }, 'Xavier + Maya are live', 'Join them'],
      ['group_live', { groupName: 'Weekend Crew', names: ['Xavier', 'Maya', 'Sam', 'Ben'] }, 'Weekend Crew is live', 'Xavier, Maya + 2'],
      ['group_live', { groupName: 'Weekend Crew', names: ['Xavier', 'Maya'], total: 4 }, 'Weekend Crew is live', 'Xavier, Maya + 2'],
      ['group_live', { groupName: 'Weekend Crew', names: ['Xavier'] }, 'Weekend Crew is live', 'Xavier'],
      ['friend_request', { name: 'Maya' }, 'Maya wants to be friends', ''],
      ['friend_accepted', { name: 'Maya' }, 'You and Maya are friends', ''],
      ['follow', { name: 'Sam' }, 'Sam followed you', ''],
      ['group_invitation', { name: 'Xavier', groupName: 'Weekend Crew' }, 'Xavier brought you into Weekend Crew', ''],
    ]
    expect(new Set(cases.map((c) => c[0]))).toEqual(new Set(NOTIFICATION_TYPES))
    for (const [type, payload, title, body] of cases) {
      const id = await insertNotification(db, { recipient: alice, type, actor: bob, payload, createdAt: at(1) })
      const page = await listNotifications(db, alice.as, { limit: 1 })
      const dto = page.notifications[0]
      expect(dto?.id, `${type} ${JSON.stringify(payload)}`).toBe(id)
      expect({ title: dto?.title, body: dto?.body }, `${type} ${JSON.stringify(payload)}`).toEqual({ title, body })
      // Parity with the TypeScript copy builder the server and clients use.
      expect(notificationCopyFromPayload(type, payload), `${type} ${JSON.stringify(payload)}`).toEqual({ title, body })
      expect(dto?.payload).toEqual(payload)
      await db.sql.query('delete from public.notifications where id = $1', [id])
    }
  })

  it('an unusable payload still yields a DTO with a non-empty title', async () => {
    for (const type of NOTIFICATION_TYPES) {
      const id = await insertNotification(db, { recipient: alice, type, actor: bob, payload: {} })
      const page = await listNotifications(db, alice.as, { limit: 1 })
      expect(page.notifications[0]?.id).toBe(id)
      expect(NotificationDtoSchema.safeParse(page.notifications[0]).success, type).toBe(true)
      expect(page.notifications[0]?.title.length, type).toBeGreaterThan(0)
      await db.sql.query('delete from public.notifications where id = $1', [id])
    }
  })

  it('notification_mark_read marks the caller\'s row once and returns its DTO', async () => {
    const id = await insertNotification(db, { recipient: alice, type: 'friend_request', actor: bob, payload: { name: 'Bob' } })
    expect((await listNotifications(db, alice.as, {})).unreadCount).toBe(1)
    const marked = NotificationDtoSchema.parse(await db.rpc('notification_mark_read', { id }, alice.as))
    expect(marked.id).toBe(id)
    expect(marked.readAt).not.toBeNull()
    expect(marked.title).toBe('Bob wants to be friends')
    const firstReadAt = await readAt(db, id)
    expect(firstReadAt).not.toBeNull()
    // Idempotent: a second call keeps the first timestamp.
    await db.rpc('notification_mark_read', { id }, alice.as)
    expect(await readAt(db, id)).toBe(firstReadAt)
    const page = await listNotifications(db, alice.as, {})
    expect(page.unreadCount).toBe(0)
    expect(page.notifications[0]?.readAt).toBe(marked.readAt)
    // Still listed after being read.
    expect(page.notifications.map((n) => n.id)).toContain(id)
    // Somebody else's notification is not visible, whether it exists or not.
    await db.expectError(db.rpc('notification_mark_read', { id }, bob.as), 'not_visible')
    await db.expectError(
      db.rpc('notification_mark_read', { id: '00000000-0000-0000-0000-000000000000' }, alice.as),
      'not_visible',
    )
    await db.expectError(db.rpc('notification_mark_read', { id: null }, alice.as), 'invalid_input')
    expect(await readAt(db, id)).toBe(firstReadAt)
    await db.sql.query('delete from public.notifications where id = $1', [id])
  })

  it('notifications_mark_all_read and notifications_unread_count cover the caller only', async () => {
    const mine = [
      await insertNotification(db, { recipient: alice, type: 'follow', actor: bob }),
      await insertNotification(db, { recipient: alice, type: 'friend_request', actor: bob }),
      await insertNotification(db, { recipient: alice, type: 'friend_accepted', actor: bob, readAt: at(1) }),
    ]
    const bobs = await insertNotification(db, { recipient: bob, type: 'follow', actor: alice })
    expect(await db.rpc('notifications_unread_count', {}, alice.as)).toEqual({ unreadCount: 2 })
    expect(await db.rpc('notifications_unread_count', {}, bob.as)).toEqual({ unreadCount: 1 })
    expect(await db.rpc('notifications_mark_all_read', {}, alice.as)).toEqual({ markedCount: 2, unreadCount: 0 })
    for (const id of mine) expect(await readAt(db, id)).not.toBeNull()
    expect(await readAt(db, bobs)).toBeNull()
    expect(await db.rpc('notifications_unread_count', {}, alice.as)).toEqual({ unreadCount: 0 })
    expect((await listNotifications(db, alice.as, {})).unreadCount).toBe(0)
    expect(await db.rpc('notifications_mark_all_read', {}, alice.as)).toEqual({ markedCount: 0, unreadCount: 0 })
    expect(await db.rpc('notifications_unread_count', {}, bob.as)).toEqual({ unreadCount: 1 })
    await db.sql.query('delete from public.notifications')
  })

  it('read mutations are rate limited per caller', async () => {
    const id = await insertNotification(db, { recipient: alice, type: 'follow', actor: bob })
    await db.sql.query('delete from private.rate_limits')
    await db.sql.query(
      `insert into private.rate_limits (key, window_start, expires_at, count)
       values ($1, now(), now() + interval '1 hour', 600), ($2, now(), now() + interval '1 hour', 120)`,
      [`notification_mark_read:${alice.userId}`, `notifications_mark_all_read:${alice.userId}`],
    )
    await db.expectError(db.rpc('notification_mark_read', { id }, alice.as), 'rate_limited')
    await db.expectError(db.rpc('notifications_mark_all_read', {}, alice.as), 'rate_limited')
    expect(await readAt(db, id)).toBeNull()
    // Reads are never rate limited.
    expect((await listNotifications(db, alice.as, {})).unreadCount).toBe(1)
    await db.sql.query('delete from private.rate_limits')
    await db.sql.query('delete from public.notifications')
  })

  it('only active Humans may call the client RPCs', async () => {
    const id = await insertNotification(db, { recipient: alice, type: 'follow', actor: bob })
    const calls: Array<[string, Record<string, unknown>]> = [
      ['notifications_list', { cursor: null, limit: 10 }],
      ['notifications_unread_count', {}],
      ['notification_mark_read', { id }],
      ['notifications_mark_all_read', {}],
    ]
    for (const [name, args] of calls) {
      await db.expectError(db.rpc(name, args, 'visitor'), 'not_authenticated')
      await db.expectError(db.rpc(name, args, guest.as), 'not_a_human')
      await db.expectError(db.rpc(name, args, claiming.as), 'not_a_human')
      await db.expectError(db.rpc(name, args, unclaimed.as), 'not_a_human')
      await db.expectError(db.rpc(name, args, suspended.as), 'human_not_active')
      await db.expectError(db.rpc(name, args, 'service'), 'not_a_human')
    }
    expect(await readAt(db, id)).toBeNull()
  })
})
