import { RelationshipChangeDtoSchema } from '@earth/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  count,
  createGuest,
  createHuman,
  notificationsFor,
  relate,
  scalar,
  type Human,
} from './fixtures'

async function edges(db: TestDb, a: Human, b: Human): Promise<string[]> {
  const { rows } = await db.sql.query<{ edge: string }>(
    `select case when source_human_id = $1 then 'ab:' else 'ba:' end || type::text as edge
       from public.relationships
      where (source_human_id = $1 and target_human_id = $2) or (source_human_id = $2 and target_human_id = $1)
      order by 1`,
    [a.humanId, b.humanId],
  )
  return rows.map((r) => r.edge)
}

describe('social graph RPCs (spec §20–21; mirror packages/domain/src/social/rules.ts)', () => {
  let db: TestDb
  let alice: Human
  let bob: Human
  let carol: Human
  let pending: Human

  beforeAll(async () => {
    db = await createTestDb()
    alice = await createHuman(db, { handle: 'alice', displayName: 'Alice' })
    bob = await createHuman(db, { handle: 'bob', displayName: 'Bob' })
    carol = await createHuman(db, { handle: 'carol', displayName: 'Carol' })
    pending = await createHuman(db, { handle: 'pend', status: 'pending' })
  })

  afterAll(async () => {
    await db.drop()
  })

  it('only active Humans may act on the graph', async () => {
    const guest = await createGuest(db)
    for (const rpc of ['friend_request_send', 'follow_set', 'block_set']) {
      await db.expectError(
        db.rpc(rpc, { target_human_id: bob.humanId }, 'visitor'),
        'not_authenticated',
      )
      await db.expectError(db.rpc(rpc, { target_human_id: bob.humanId }, guest.as), 'not_a_human')
      await db.expectError(db.rpc(rpc, { target_human_id: bob.humanId }, pending.as), 'not_a_human')
      await db.expectError(
        db.rpc(rpc, { target_human_id: alice.humanId }, alice.as),
        'invalid_input',
      )
    }
    await db.expectError(
      db.rpc('friend_request_send', { target_human_id: pending.humanId }, alice.as),
      'not_visible',
    )
    await db.expectError(
      db.rpc('follow_set', { target_human_id: pending.humanId }, alice.as),
      'not_visible',
    )
  })

  it('friend_request_send is idempotent and notifies once', async () => {
    const first = RelationshipChangeDtoSchema.parse(
      await db.rpc('friend_request_send', { target_human_id: bob.humanId }, alice.as),
    )
    expect(first).toMatchObject({
      humanId: bob.humanId,
      isFriend: false,
      friendRequest: 'sent',
      isFollowing: false,
    })
    const second = RelationshipChangeDtoSchema.parse(
      await db.rpc('friend_request_send', { target_human_id: bob.humanId }, alice.as),
    )
    expect(second.friendRequest).toBe('sent')
    expect(await edges(db, alice, bob)).toEqual(['ab:friend_pending'])
    const bobsNotifications = await notificationsFor(db, bob)
    expect(bobsNotifications).toEqual([
      {
        type: 'friend_request',
        actor_human_id: alice.humanId,
        priority: 'high',
        payload: { name: 'Alice' },
      },
    ])
    const bobSees = await db.rpc<{ relationship: { friendRequest: string } }>(
      'profile_get',
      { handle: 'alice' },
      bob.as,
    )
    expect(bobSees.relationship.friendRequest).toBe('received')
  })

  it('mutual pending → friends (the second send accepts) and notifies the original requester', async () => {
    const accepted = RelationshipChangeDtoSchema.parse(
      await db.rpc('friend_request_send', { target_human_id: alice.humanId }, bob.as),
    )
    expect(accepted).toMatchObject({
      humanId: alice.humanId,
      isFriend: true,
      friendRequest: 'none',
    })
    expect(await edges(db, alice, bob)).toEqual(['ab:friend', 'ba:friend'])
    expect(await notificationsFor(db, alice)).toEqual([
      {
        type: 'friend_accepted',
        actor_human_id: bob.humanId,
        priority: 'high',
        payload: { name: 'Bob' },
      },
    ])
    // Already friends: sending again is a no-op (no extra rows or notifications).
    await db.rpc('friend_request_send', { target_human_id: alice.humanId }, bob.as)
    expect(await edges(db, alice, bob)).toEqual(['ab:friend', 'ba:friend'])
    expect((await notificationsFor(db, alice)).length).toBe(1)
    expect((await notificationsFor(db, bob)).length).toBe(1)
  })

  it('accept / decline / remove', async () => {
    await db.expectError(
      db.rpc('friend_request_accept', { source_human_id: carol.humanId }, alice.as),
      'invalid_input',
    )
    await db.rpc('friend_request_send', { target_human_id: alice.humanId }, carol.as)
    const declined = RelationshipChangeDtoSchema.parse(
      await db.rpc('friend_request_decline', { source_human_id: carol.humanId }, alice.as),
    )
    expect(declined.friendRequest).toBe('none')
    expect(await edges(db, alice, carol)).toEqual([])

    await db.rpc('friend_request_send', { target_human_id: alice.humanId }, carol.as)
    const accepted = RelationshipChangeDtoSchema.parse(
      await db.rpc('friend_request_accept', { source_human_id: carol.humanId }, alice.as),
    )
    expect(accepted.isFriend).toBe(true)
    expect(await edges(db, alice, carol)).toEqual(['ab:friend', 'ba:friend'])
    expect((await notificationsFor(db, carol)).map((n) => n.type)).toEqual(['friend_accepted'])

    const removed = RelationshipChangeDtoSchema.parse(
      await db.rpc('friend_remove', { other_human_id: carol.humanId }, alice.as),
    )
    expect(removed.isFriend).toBe(false)
    expect(await edges(db, alice, carol)).toEqual([])
  })

  it('follow is directional, idempotent, never implies friendship, notifies once', async () => {
    const followed = RelationshipChangeDtoSchema.parse(
      await db.rpc('follow_set', { target_human_id: carol.humanId, following: true }, alice.as),
    )
    expect(followed).toMatchObject({ isFollowing: true, isFriend: false, friendRequest: 'none' })
    await db.rpc('follow_set', { target_human_id: carol.humanId, following: true }, alice.as)
    expect(await edges(db, alice, carol)).toEqual(['ab:follow'])
    expect((await notificationsFor(db, carol)).filter((n) => n.type === 'follow')).toEqual([
      {
        type: 'follow',
        actor_human_id: alice.humanId,
        priority: 'low',
        payload: { name: 'Alice' },
      },
    ])
    const carolSees = await db.rpc<{ relationship: Record<string, unknown> }>(
      'profile_get',
      { handle: 'alice' },
      carol.as,
    )
    expect(carolSees.relationship).toMatchObject({
      isFollowedBy: true,
      isFollowing: false,
      isFriend: false,
    })
    const unfollowed = RelationshipChangeDtoSchema.parse(
      await db.rpc('follow_set', { target_human_id: carol.humanId, following: false }, alice.as),
    )
    expect(unfollowed.isFollowing).toBe(false)
    expect(await edges(db, alice, carol)).toEqual([])
  })

  it('block removes friend/pending/follow edges both ways, keeps familiar_private, and blocks further requests', async () => {
    await relate(db, alice, carol, 'familiar_private')
    await relate(db, carol, alice, 'follow')
    await relate(db, alice, carol, 'follow')
    await relate(db, carol, alice, 'friend_pending')
    const carolBefore = (await notificationsFor(db, carol)).length
    const blocked = await db.rpc<{ isBlocked: boolean; isFriend: boolean; isFollowing: boolean }>(
      'block_set',
      { target_human_id: carol.humanId, blocked: true },
      alice.as,
    )
    expect(blocked).toMatchObject({ isBlocked: true, isFriend: false, isFollowing: false })
    expect(await edges(db, alice, carol)).toEqual(['ab:familiar_private'])
    expect(
      await count(db, 'public.blocks', 'blocker_human_id = $1 and blocked_human_id = $2', [
        alice.humanId,
        carol.humanId,
      ]),
    ).toBe(1)
    expect(
      await count(db, 'private.audit_log', "action = 'block_set' and target_id = $1", [
        carol.humanId,
      ]),
    ).toBe(1)

    for (const [actor, target] of [
      [alice, carol],
      [carol, alice],
    ] as const) {
      await db.expectError(
        db.rpc('friend_request_send', { target_human_id: target.humanId }, actor.as),
        'blocked',
      )
      await db.expectError(
        db.rpc('follow_set', { target_human_id: target.humanId }, actor.as),
        'blocked',
      )
      await db.expectError(
        db.rpc('conversation_direct_get_or_create', { other_human_id: target.humanId }, actor.as),
        'blocked',
      )
      await db.expectError(
        db.rpc('profile_get', { handle: target.handle }, actor.as),
        'not_visible',
      )
    }
    await db.expectError(
      db.rpc('friend_request_accept', { source_human_id: alice.humanId }, carol.as),
      'blocked',
    )
    // No notification crosses a block.
    expect((await notificationsFor(db, carol)).length).toBe(carolBefore)

    // Blocking twice is a no-op; unblocking restores the ability to connect.
    await db.rpc('block_set', { target_human_id: carol.humanId, blocked: true }, alice.as)
    expect(await count(db, 'public.blocks', 'blocker_human_id = $1', [alice.humanId])).toBe(1)
    const unblocked = await db.rpc<{ isBlocked: boolean }>(
      'block_set',
      { target_human_id: carol.humanId, blocked: false },
      alice.as,
    )
    expect(unblocked.isBlocked).toBe(false)
    expect(
      (
        await db.rpc<{ friendRequest: string }>(
          'friend_request_send',
          { target_human_id: carol.humanId },
          alice.as,
        )
      ).friendRequest,
    ).toBe('sent')
  })

  it('block_set accepts any non-pending Human and rejects the rest', async () => {
    await db.expectError(
      db.rpc('block_set', { target_human_id: pending.humanId }, alice.as),
      'not_visible',
    )
    await db.expectError(
      db.rpc('block_set', { target_human_id: '00000000-0000-0000-0000-000000000000' }, alice.as),
      'not_visible',
    )
    const suspended = await createHuman(db, { handle: 'susp', status: 'suspended' })
    expect(
      (
        await db.rpc<{ isBlocked: boolean }>(
          'block_set',
          { target_human_id: suspended.humanId },
          alice.as,
        )
      ).isBlocked,
    ).toBe(true)
  })

  it('RLS: relationships visible to source, to target except familiar_private; blocks only to the blocker', async () => {
    const dave = await createHuman(db, { handle: 'dave' })
    const erin = await createHuman(db, { handle: 'erin' })
    await relate(db, dave, erin, 'familiar_private')
    await relate(db, dave, erin, 'follow')
    await relate(db, erin, dave, 'friend_pending')
    const rows = async (as: RoleSpec) => {
      const { rows: r } = await db.asRole(as, (c) =>
        c.query<{ type: string }>(
          'select type::text as type from public.relationships where source_human_id = any($1) and target_human_id = any($1) order by 1',
          [[dave.humanId, erin.humanId]],
        ),
      )
      return r.map((x) => x.type)
    }
    expect(await rows(dave.as)).toEqual(['familiar_private', 'follow', 'friend_pending'])
    expect(await rows(erin.as)).toEqual(['follow', 'friend_pending'])
    expect(await rows(alice.as)).toEqual([])
    expect(await rows(pending.as)).toEqual([])
    await expect(
      db.asRole('visitor', (c) => c.query('select * from public.relationships')),
    ).rejects.toMatchObject({ code: '42501' })

    await db.rpc('block_set', { target_human_id: erin.humanId }, dave.as)
    const blocksOf = async (as: RoleSpec) =>
      (await db.asRole(as, (c) => c.query('select blocked_human_id from public.blocks'))).rowCount
    expect(await blocksOf(dave.as)).toBe(1)
    expect(await blocksOf(erin.as)).toBe(0)
    await expect(
      db.asRole(dave.as, (c) => c.query('delete from public.blocks')),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      db.asRole(dave.as, (c) =>
        c.query(
          "insert into public.relationships (source_human_id, target_human_id, type) values ($1, $2, 'friend')",
          [dave.humanId, erin.humanId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('friend requests are rate limited (spec §83: 60/h)', async () => {
    const spammer = await createHuman(db, { handle: 'spam' })
    const target = await createHuman(db, { handle: 'target' })
    for (let i = 0; i < 60; i += 1) {
      await db.rpc('friend_request_send', { target_human_id: target.humanId }, spammer.as)
    }
    await db.expectError(
      db.rpc('friend_request_send', { target_human_id: target.humanId }, spammer.as),
      'rate_limited',
    )
    expect(
      await scalar(db, "count from private.rate_limits where key = 'friend_request:' || $1", [
        spammer.userId,
      ]),
    ).toBe(60)
  })
})
