/**
 * Schema, column and publication lockdown (ARCHITECTURE §5, §15; DB_API §1 "RLS summary",
 * §2 realtime; spec §114 — launch blocker).
 *
 * The database authorization matrix rests on three structural guarantees that no per-table policy
 * can restore once broken:
 *   1. `earth` and `private` carry no USAGE for `anon`/`authenticated`, so a client can never name
 *      an internal helper or table directly (0002); `service_role` keeps `earth` (definer helpers)
 *      but never `private`.
 *   2. The secret-bearing tables (`private.human_pass_metadata`, `private.rate_limits`,
 *      `private.audit_log`) are closed to every API role, and the token/secret hash columns
 *      (`token_hash`, `session_secret_hash`) are never column-granted anywhere — the client reads
 *      invites and guest sessions through the hash-free views only (0170, 0320).
 *   3. `supabase_realtime` publishes exactly the tables the contract streams (ARCHITECTURE §5):
 *      RLS governs delivery, so a stray table in the publication would leak change events.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DB_ROLES, createTestDb, type TestDb } from '../harness'

const CLIENT_ROLES = [DB_ROLES.anon, DB_ROLES.authenticated] as const
const PUBLIC_ROLE = 'public'
const TABLE_PRIVILEGES = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'TRUNCATE',
  'REFERENCES',
  'TRIGGER',
] as const

/** Tables that hold secrets or internal bookkeeping and must be unreachable by every API role. */
const CLOSED_PRIVATE_TABLES = [
  'private.human_pass_metadata',
  'private.rate_limits',
  'private.audit_log',
] as const

/** Columns that store a `sha256` hash of a token/secret and must never be column-granted (DB_API §1/§3). */
const SECRET_COLUMNS = ['token_hash', 'session_secret_hash'] as const

/** The realtime publication contract (ARCHITECTURE §5, DB_API §2/§3/§6). */
const REALTIME_TABLES = [
  'conversation_members',
  'conversations',
  'message_reactions',
  'messages',
  'notifications',
  'room_participants',
  'rooms',
] as const

async function schemaUsage(db: TestDb, role: string, schema: string): Promise<boolean> {
  const { rows } = await db.sql.query<{ ok: boolean }>(
    'select has_schema_privilege($1, $2, $3) as ok',
    [role, schema, 'USAGE'],
  )
  return rows[0]?.ok ?? false
}

async function anyTablePrivilege(db: TestDb, role: string, table: string): Promise<string[]> {
  const { rows } = await db.sql.query<{ privilege: string }>(
    `select p.privilege from unnest($3::text[]) as p(privilege)
      where has_table_privilege($1, $2, p.privilege) order by p.privilege`,
    [role, table, TABLE_PRIVILEGES as unknown as string[]],
  )
  return rows.map((r) => r.privilege)
}

describe('schema, column and publication lockdown (0002, 0170, 0320, realtime)', () => {
  let db: TestDb

  beforeAll(async () => {
    db = await createTestDb()
  })

  afterAll(async () => {
    await db.drop()
  })

  it('anon and authenticated have no USAGE on earth or private', async () => {
    for (const role of CLIENT_ROLES) {
      expect(await schemaUsage(db, role, 'earth'), `${role} usage on earth`).toBe(false)
      expect(await schemaUsage(db, role, 'private'), `${role} usage on private`).toBe(false)
    }
    // The PUBLIC pseudo-role is revoked too, so a future login role inherits nothing.
    expect(await schemaUsage(db, PUBLIC_ROLE, 'earth'), 'public usage on earth').toBe(false)
    expect(await schemaUsage(db, PUBLIC_ROLE, 'private'), 'public usage on private').toBe(false)
    // service_role reaches earth (it owns nothing but runs definer helpers) but never private.
    expect(await schemaUsage(db, DB_ROLES.service_role, 'earth')).toBe(true)
    expect(await schemaUsage(db, DB_ROLES.service_role, 'private')).toBe(false)
  })

  it('the secret-bearing private tables are closed to every API role and to PUBLIC', async () => {
    for (const table of CLOSED_PRIVATE_TABLES) {
      for (const role of [...CLIENT_ROLES, DB_ROLES.service_role, PUBLIC_ROLE]) {
        expect(await anyTablePrivilege(db, role, table), `${role} on ${table}`).toEqual([])
      }
    }
  })

  it('anon and authenticated cannot even name an earth helper or a private table directly', async () => {
    for (const as of ['visitor', 'service'] as const) {
      const usable = as === 'service'
      const helper = db.asRole(as, (client) => client.query('select earth.utc_now()'))
      if (usable) {
        expect((await helper).rows).toHaveLength(1)
      } else {
        await expect(helper).rejects.toMatchObject({ code: '42501' })
      }
    }
    await expect(
      db.asRole({ userId: await db.createAuthUser() }, (client) =>
        client.query('select * from private.rate_limits'),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('no token_hash / session_secret_hash column is granted to anon or authenticated anywhere', async () => {
    const { rows } = await db.sql.query<{
      table_schema: string
      table_name: string
      column_name: string
      grantee: string
      privilege_type: string
    }>(
      `select table_schema, table_name, column_name, grantee, privilege_type
         from information_schema.column_privileges
        where grantee = any($1::text[]) and column_name = any($2::text[])
        order by 1, 2, 3, 4, 5`,
      [[...CLIENT_ROLES], [...SECRET_COLUMNS]],
    )
    expect(rows).toEqual([])
  })

  it('the invite/guest hash columns exist only on the base tables, and their tables are ungranted', async () => {
    // Every hash/secret column the schema carries, so the assertion above cannot pass by absence.
    const { rows } = await db.sql.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
        where table_schema = 'public' and column_name = any($1::text[]) order by 1, 2`,
      [[...SECRET_COLUMNS]],
    )
    expect(rows).toEqual([
      { table_name: 'group_invites', column_name: 'token_hash' },
      { table_name: 'guest_sessions', column_name: 'session_secret_hash' },
      { table_name: 'room_invites', column_name: 'token_hash' },
    ])
    // Those base tables have no client grants at all (clients read the hash-free *_view only).
    for (const table of ['public.group_invites', 'public.guest_sessions', 'public.room_invites']) {
      for (const role of CLIENT_ROLES) {
        expect(await anyTablePrivilege(db, role, table), `${role} on ${table}`).toEqual([])
      }
    }
    // The device-fingerprint hashes are equally never exposed by a client grant.
    const { rows: fp } = await db.sql.query<{ table_name: string; grantee: string }>(
      `select table_name, grantee from information_schema.column_privileges
        where grantee = any($1::text[]) and column_name in ('device_fingerprint_hash', 'fingerprint_hash')`,
      [[...CLIENT_ROLES]],
    )
    expect(fp).toEqual([])
  })

  it('supabase_realtime publishes exactly the intended tables, all with full replica identity', async () => {
    const { rows } = await db.sql.query<{ tablename: string }>(
      `select tablename from pg_publication_tables
        where pubname = 'supabase_realtime' and schemaname = 'public' order by tablename`,
    )
    expect(rows.map((r) => r.tablename)).toEqual([...REALTIME_TABLES])

    // Filtered subscriptions and delete events need the full old row, so replica identity is FULL
    // for the two tables clients filter by a non-key column; the rest keep it FULL too (0280/0340)
    // except the primary-key-filtered ones, which are safe with the default. Assert what ships.
    const { rows: identity } = await db.sql.query<{ relname: string; relreplident: string }>(
      `select relname, relreplident from pg_class
        where oid = any($1::regclass[]) order by relname`,
      [REALTIME_TABLES.map((t) => `public.${t}`)],
    )
    const byName = new Map(identity.map((r) => [r.relname, r.relreplident]))
    for (const table of ['messages', 'message_reactions', 'rooms', 'room_participants']) {
      expect(byName.get(table), `${table} replica identity`).toBe('f')
    }
  })

  it('the migration ledger is RLS-protected and closed to clients', async () => {
    const { rows } = await db.sql.query<{ rls: boolean }>(
      `select relrowsecurity as rls from pg_class where oid = 'public.earth_migrations'::regclass`,
    )
    expect(rows[0]?.rls).toBe(true)
    for (const role of CLIENT_ROLES) {
      expect(await anyTablePrivilege(db, role, 'public.earth_migrations'), role).toEqual([])
    }
  })
})
