/**
 * Blocks override notifications (spec §21, §128; ARCHITECTURE §11): a blocked actor's notification
 * never exists. `earth.notify` skips blocked pairs, and the social/messaging RPCs refuse the action
 * outright with `blocked`, so nothing reaches the recipient's list or the push queue.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestDb, type TestDb } from '../harness'
import {
  count,
  createHuman,
  directConversation,
  listNotifications,
  unsent,
  type Human,
} from './fixtures'

describe('blocked actors never create notifications', () => {
  let db: TestDb
  let alice: Human
  let bob: Human
  let carol: Human

  beforeAll(async () => {
    db = await createTestDb()
    alice = await createHuman(db, { handle: 'alice', displayName: 'Alice' })
    bob = await createHuman(db, { handle: 'bob', displayName: 'Bob' })
    carol = await createHuman(db, { handle: 'carol', displayName: 'Carol' })
  })

  beforeEach(async () => {
    await db.sql.query('delete from private.rate_limits')
  })

  afterAll(async () => {
    await db.drop()
  })

  it('friend_request_send after being blocked by the target raises blocked and writes nothing', async () => {
    await db.rpc('block_set', { target_human_id: alice.humanId }, bob.as)
    await db.expectError(
      db.rpc('friend_request_send', { target_human_id: bob.humanId }, alice.as),
      'blocked',
    )
    await db.expectError(
      db.rpc('follow_set', { target_human_id: bob.humanId }, alice.as),
      'blocked',
    )
    expect(await count(db, 'public.notifications', 'recipient_human_id = $1', [bob.humanId])).toBe(
      0,
    )
    expect(await listNotifications(db, bob.as, {})).toEqual({
      notifications: [],
      nextCursor: null,
      unreadCount: 0,
    })
    expect(await unsent(db)).toEqual([])
    expect(await count(db, 'public.relationships', 'source_human_id = $1', [alice.humanId])).toBe(0)
  })

  it('the blocker cannot notify the blocked Human either', async () => {
    await db.expectError(
      db.rpc('friend_request_send', { target_human_id: alice.humanId }, bob.as),
      'blocked',
    )
    await db.expectError(
      db.rpc('friend_request_accept', { source_human_id: alice.humanId }, bob.as),
      'blocked',
    )
    expect(
      await count(db, 'public.notifications', 'recipient_human_id = $1', [alice.humanId]),
    ).toBe(0)
    expect((await listNotifications(db, alice.as, {})).unreadCount).toBe(0)
  })

  it('a message across a block is refused before any notification exists', async () => {
    await db.rpc('block_set', { target_human_id: carol.humanId }, alice.as)
    await db.expectError(directConversation(db, alice, carol), 'blocked')
    await db.expectError(directConversation(db, carol, alice), 'blocked')
    expect(await count(db, 'public.notifications')).toBe(0)
  })

  it('earth.notify itself skips a blocked pair whichever side blocked', async () => {
    await db.sql.query(`
      create function public.probe_notify(recipient uuid, actor uuid)
      returns uuid language sql security definer set search_path = public, earth, private, pg_temp
      as $$ select earth.notify(recipient, 'follow', actor, 'human', actor, jsonb_build_object('name', 'X')) $$;
    `)
    const { rows } = await db.sql.query<{ a: string | null; b: string | null; c: string | null }>(
      'select public.probe_notify($1, $2) as a, public.probe_notify($2, $1) as b, public.probe_notify($1, $3) as c',
      [alice.humanId, bob.humanId, carol.humanId],
    )
    expect(rows[0]).toEqual({ a: null, b: null, c: null })
    expect(await count(db, 'public.notifications')).toBe(0)
    await db.sql.query('drop function public.probe_notify(uuid, uuid)')
  })

  it('unblocking restores delivery, with the spec copy', async () => {
    await db.rpc('block_set', { target_human_id: alice.humanId, blocked: false }, bob.as)
    await db.rpc('friend_request_send', { target_human_id: bob.humanId }, alice.as)
    const page = await listNotifications(db, bob.as, {})
    expect(page.unreadCount).toBe(1)
    expect(page.notifications[0]).toMatchObject({
      type: 'friend_request',
      priority: 'high',
      actorHumanId: alice.humanId,
      objectType: 'human',
      objectId: alice.humanId,
      title: 'Alice wants to be friends',
      body: '',
      readAt: null,
    })
    const queued = await unsent(db)
    expect(queued.map((r) => r.id)).toEqual([page.notifications[0]?.id])
    // Blocking again stops anything new (the pending request is dropped by block_set).
    await db.rpc('block_set', { target_human_id: alice.humanId }, bob.as)
    await db.expectError(
      db.rpc('follow_set', { target_human_id: bob.humanId }, alice.as),
      'blocked',
    )
    expect(await count(db, 'public.notifications', 'recipient_human_id = $1', [bob.humanId])).toBe(
      1,
    )
    expect(await count(db, 'public.relationships', "type = 'friend_pending'")).toBe(0)
  })
})
