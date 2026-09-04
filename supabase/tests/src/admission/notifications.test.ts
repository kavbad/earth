import {
  NOTIFICATION_OBJECT_TYPES,
  NOTIFICATION_PAYLOAD_SCHEMAS,
  NOTIFICATION_PRIORITY_BY_TYPE,
  NOTIFICATION_TYPES,
  type NotificationType,
} from '@earth/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DB_ROLES, createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  block,
  count,
  createGuest,
  createHuman,
  notificationsFor,
  scalar,
  type Human,
} from './fixtures'

describe('notifications primitive (spec §40, §86; ARCHITECTURE §11; 0190)', () => {
  let db: TestDb
  let alice: Human
  let bob: Human
  let carol: Human
  let pending: Human

  const notify = (args: Record<string, unknown>) =>
    db.rpc<string | null>('probe_notify', args, 'service')

  beforeAll(async () => {
    db = await createTestDb()
    alice = await createHuman(db, { handle: 'alice', displayName: 'Alice' })
    bob = await createHuman(db, { handle: 'bob', displayName: 'Bob' })
    carol = await createHuman(db, { handle: 'carol', displayName: 'Carol' })
    pending = await createHuman(db, { handle: 'pend', status: 'pending' })
    await db.sql.query(`
      create function public.probe_notify(recipient uuid, type text, actor uuid, object_type text, object_id uuid, payload jsonb default '{}', priority public.notification_priority default null)
      returns uuid language sql security definer set search_path = public, earth, private, pg_temp
      as $$ select earth.notify(recipient, type, actor, object_type, object_id, payload, priority) $$;
      grant execute on function public.probe_notify(uuid, text, uuid, text, uuid, jsonb, public.notification_priority) to service_role;
    `)
  })

  afterAll(async () => {
    await db.drop()
  })

  it('notification_type is the domain NOTIFICATION_TYPES list, in order', async () => {
    const { rows } = await db.sql.query<{ values: string[] }>(
      `select array_agg(e.enumlabel::text order by e.enumsortorder) as values
         from pg_type t join pg_namespace n on n.oid = t.typnamespace join pg_enum e on e.enumtypid = t.oid
        where n.nspname = 'earth' and t.typname = 'notification_type'`,
    )
    expect(rows[0]?.values).toEqual([...NOTIFICATION_TYPES])
    expect(
      await scalar(
        db,
        "format_type(atttypid, atttypmod) from pg_attribute where attrelid = 'public.notifications'::regclass and attname = 'type'",
      ),
    ).toBe('earth.notification_type')
    // Every object type the domain names is accepted by the check constraint, nothing else.
    for (const objectType of NOTIFICATION_OBJECT_TYPES) {
      expect(
        await notify({
          recipient: alice.humanId,
          type: 'follow',
          actor: bob.humanId,
          object_type: objectType,
          object_id: bob.humanId,
        }),
      ).not.toBeNull()
    }
    await expect(
      notify({
        recipient: alice.humanId,
        type: 'follow',
        actor: bob.humanId,
        object_type: 'planet',
        object_id: bob.humanId,
      }),
    ).rejects.toMatchObject({ code: '23514' })
    await db.sql.query('delete from public.notifications')
  })

  it('earth.notify skips self, blocked pairs and inactive recipients; rejects unknown types', async () => {
    expect(
      await notify({
        recipient: alice.humanId,
        type: 'follow',
        actor: alice.humanId,
        object_type: 'human',
        object_id: alice.humanId,
      }),
    ).toBeNull()
    expect(
      await notify({
        recipient: pending.humanId,
        type: 'follow',
        actor: alice.humanId,
        object_type: 'human',
        object_id: alice.humanId,
      }),
    ).toBeNull()
    expect(
      await notify({
        recipient: null,
        type: 'follow',
        actor: alice.humanId,
        object_type: 'human',
        object_id: alice.humanId,
      }),
    ).toBeNull()
    await block(db, carol, alice)
    expect(
      await notify({
        recipient: carol.humanId,
        type: 'follow',
        actor: alice.humanId,
        object_type: 'human',
        object_id: alice.humanId,
      }),
    ).toBeNull()
    expect(
      await notify({
        recipient: alice.humanId,
        type: 'follow',
        actor: carol.humanId,
        object_type: 'human',
        object_id: carol.humanId,
      }),
    ).toBeNull()
    await db.expectError(
      notify({
        recipient: alice.humanId,
        type: 'like',
        actor: bob.humanId,
        object_type: 'human',
        object_id: bob.humanId,
      }),
      'invalid_input',
    )
    await db.expectError(
      notify({
        recipient: alice.humanId,
        type: 'follow',
        actor: bob.humanId,
        object_type: null,
        object_id: bob.humanId,
      }),
      'invalid_input',
    )
    // System notifications (no actor) still reach active recipients.
    expect(
      await notify({
        recipient: alice.humanId,
        type: 'group_invitation',
        actor: null,
        object_type: 'group',
        object_id: alice.humanId,
        payload: { name: 'Xavier', groupName: 'Crew' },
      }),
    ).not.toBeNull()
    expect(
      await count(db, 'public.notifications', 'recipient_human_id = $1', [alice.humanId]),
    ).toBe(1)
    await db.sql.query('delete from public.notifications')
  })

  it('priority defaults to the domain mapping and can be overridden', async () => {
    for (const type of NOTIFICATION_TYPES) {
      const id = await notify({
        recipient: alice.humanId,
        type,
        actor: bob.humanId,
        object_type: 'human',
        object_id: bob.humanId,
      })
      expect(
        await scalar(db, 'priority::text from public.notifications where id = $1', [id]),
        type,
      ).toBe(NOTIFICATION_PRIORITY_BY_TYPE[type as NotificationType])
    }
    const forced = await notify({
      recipient: alice.humanId,
      type: 'follow',
      actor: bob.humanId,
      object_type: 'human',
      object_id: bob.humanId,
      priority: 'critical_social',
    })
    expect(
      await scalar(db, 'priority::text from public.notifications where id = $1', [forced]),
    ).toBe('critical_social')
    await db.sql.query('delete from public.notifications')
  })

  it('social RPCs create friend_request / friend_accepted / follow rows with the right priority and payload', async () => {
    await db.rpc('friend_request_send', { target_human_id: bob.humanId }, alice.as)
    await db.rpc('follow_set', { target_human_id: bob.humanId }, alice.as)
    await db.rpc('friend_request_accept', { source_human_id: alice.humanId }, bob.as)
    const bobs = await notificationsFor(db, bob)
    expect(bobs.map((n) => [n.type, n.priority, n.actor_human_id])).toEqual([
      ['friend_request', 'high', alice.humanId],
      ['follow', 'low', alice.humanId],
    ])
    const alices = await notificationsFor(db, alice)
    expect(alices.map((n) => [n.type, n.priority, n.actor_human_id])).toEqual([
      ['friend_accepted', 'high', bob.humanId],
    ])
    for (const n of [...bobs, ...alices]) {
      const schema = NOTIFICATION_PAYLOAD_SCHEMAS[n.type as NotificationType]
      expect(schema.safeParse(n.payload).success, n.type).toBe(true)
    }
    expect(bobs[1]?.payload).toEqual({ name: 'Alice' })
    expect(alices[0]?.payload).toEqual({ name: 'Bob' })
    const objects = await db.sql.query<{ object_type: string; object_id: string }>(
      'select object_type, object_id from public.notifications where recipient_human_id = $1',
      [bob.humanId],
    )
    for (const row of objects.rows)
      expect(row).toEqual({ object_type: 'human', object_id: alice.humanId })
  })

  it('never notifies across a block, even through the RPCs', async () => {
    const dan = await createHuman(db, { handle: 'dan' })
    await db.rpc('friend_request_send', { target_human_id: dan.humanId }, bob.as)
    await block(db, dan, alice)
    await db.expectError(
      db.rpc('friend_request_send', { target_human_id: dan.humanId }, alice.as),
      'blocked',
    )
    await db.expectError(
      db.rpc('follow_set', { target_human_id: dan.humanId }, alice.as),
      'blocked',
    )
    expect((await notificationsFor(db, dan)).map((n) => n.actor_human_id)).toEqual([bob.humanId])
  })

  it('RLS: recipients read their own rows only; no client writes; realtime publication carries the table', async () => {
    const guest = await createGuest(db)
    expect(
      (await db.asRole(bob.as, (c) => c.query('select id from public.notifications'))).rowCount,
    ).toBe(2)
    expect(
      (await db.asRole(alice.as, (c) => c.query('select id from public.notifications'))).rowCount,
    ).toBe(1)
    expect(
      (await db.asRole(carol.as, (c) => c.query('select id from public.notifications'))).rowCount,
    ).toBe(0)
    expect(
      (await db.asRole(pending.as, (c) => c.query('select id from public.notifications'))).rowCount,
    ).toBe(0)
    expect(
      (await db.asRole(guest.as, (c) => c.query('select id from public.notifications'))).rowCount,
    ).toBe(0)
    await expect(
      db.asRole('visitor', (c) => c.query('select id from public.notifications')),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      db.asRole(bob.as, (c) => c.query('update public.notifications set read_at = now()')),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      db.asRole(bob.as, (c) => c.query('delete from public.notifications')),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      db.asRole(bob.as, (c) =>
        c.query(
          "insert into public.notifications (recipient_human_id, type, object_type, object_id, priority) values ($1, 'follow', 'human', $1, 'low')",
          [bob.humanId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    for (const as of ['visitor', bob.as, guest.as] as RoleSpec[]) {
      await expect(
        db.asRole(as, (c) => c.query('select * from public.notification_cooldowns')),
      ).rejects.toMatchObject({ code: '42501' })
    }
    expect(
      await scalar(
        db,
        "exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications')",
      ),
    ).toBe(true)
  })

  it('earth.notify is not executable by anon/authenticated', async () => {
    for (const role of [DB_ROLES.anon, DB_ROLES.authenticated, 'public']) {
      expect(
        await scalar(
          db,
          "has_function_privilege($1, 'earth.notify(uuid, text, uuid, text, uuid, jsonb, public.notification_priority)', 'EXECUTE')",
          [role],
        ),
        role,
      ).toBe(false)
    }
    expect(
      await scalar(
        db,
        "has_function_privilege('service_role', 'earth.notify(uuid, text, uuid, text, uuid, jsonb, public.notification_priority)', 'EXECUTE')",
      ),
    ).toBe(true)
  })
})

describe('audit primitive (0195)', () => {
  let db: TestDb
  let alice: Human
  let bob: Human

  beforeAll(async () => {
    db = await createTestDb()
    alice = await createHuman(db, { handle: 'alice' })
    bob = await createHuman(db, { handle: 'bob' })
  })

  afterAll(async () => {
    await db.drop()
  })

  it('records the actor of sensitive actions and is closed to every API role', async () => {
    await db.rpc('block_set', { target_human_id: bob.humanId }, alice.as)
    const { rows } = await db.sql.query(
      "select actor_human_id, actor_role, actor_auth_user_id, action, target_type, target_id, details from private.audit_log where action = 'block_set'",
    )
    expect(rows).toEqual([
      {
        actor_human_id: alice.humanId,
        actor_role: 'human',
        actor_auth_user_id: alice.userId,
        action: 'block_set',
        target_type: 'human',
        target_id: bob.humanId,
        details: { blocked: true },
      },
    ])
    for (const role of [DB_ROLES.anon, DB_ROLES.authenticated, DB_ROLES.service_role, 'public']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(
          await scalar(db, "has_table_privilege($1, 'private.audit_log', $2)", [role, privilege]),
          `${role} ${privilege}`,
        ).toBe(false)
      }
      expect(
        await scalar(
          db,
          "has_function_privilege($1, 'earth.audit(text, text, uuid, jsonb)', 'EXECUTE')",
          [role],
        ),
        role,
      ).toBe(role === DB_ROLES.service_role)
    }
    await db.expectError(db.sql.query("select earth.audit('', 'human', null)"), 'invalid_input')
    // A superuser session with no JWT audits as the service.
    await db.sql.query("select earth.audit('review_resolve', 'review', null, '{\"x\": 1}')")
    expect(
      await scalar(db, "actor_role from private.audit_log where action = 'review_resolve'"),
    ).toBe('service')
  })
})
