import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { SHIM_PATH } from '../../../scripts/db/migrate-lib'
import { DB_ROLES, createTestDb, type TestDb } from './harness'

const PERMISSION_DENIED = '42501'
const UNIQUE_VIOLATION = '23505'

describe('supabase shim', () => {
  let db: TestDb
  let alice: string
  let bob: string

  beforeAll(async () => {
    db = await createTestDb()
    alice = await db.createAuthUser({ email: 'alice@example.test' })
    bob = await db.createAuthUser({ phone: '+14155550100' })
  })

  afterAll(async () => {
    await db.drop()
  })

  it('creates the Supabase API roles with the expected attributes', async () => {
    const { rows } = await db.sql.query<{
      rolname: string
      rolcanlogin: boolean
      rolbypassrls: boolean
      rolinherit: boolean
    }>(
      `select rolname, rolcanlogin, rolbypassrls, rolinherit
         from pg_roles
        where rolname in ('anon', 'authenticated', 'service_role', 'authenticator')
        order by rolname`,
    )
    expect(rows).toEqual([
      { rolname: 'anon', rolcanlogin: false, rolbypassrls: false, rolinherit: false },
      { rolname: 'authenticated', rolcanlogin: false, rolbypassrls: false, rolinherit: false },
      { rolname: 'authenticator', rolcanlogin: true, rolbypassrls: false, rolinherit: false },
      { rolname: 'service_role', rolcanlogin: false, rolbypassrls: true, rolinherit: false },
    ])

    const members = await db.sql.query<{ role: string }>(
      `select r.rolname as role
         from pg_auth_members m
         join pg_roles r on r.oid = m.roleid
         join pg_roles u on u.oid = m.member
        where u.rolname = 'authenticator'
        order by r.rolname`,
    )
    expect(members.rows.map((row) => row.role)).toEqual([
      DB_ROLES.anon,
      DB_ROLES.authenticated,
      DB_ROLES.service_role,
    ])
  })

  it('auth.uid() returns the JWT subject and null for visitors and the service', async () => {
    const asAlice = await db.asRole({ userId: alice }, async (client) => {
      const { rows } = await client.query<{ uid: string | null }>('select auth.uid() as uid')
      return rows[0]?.uid
    })
    expect(asAlice).toBe(alice)

    const asVisitor = await db.asRole('visitor', async (client) => {
      const { rows } = await client.query<{ uid: string | null }>('select auth.uid() as uid')
      return rows[0]?.uid
    })
    expect(asVisitor).toBeNull()

    const asService = await db.asRole('service', async (client) => {
      const { rows } = await client.query<{ uid: string | null }>('select auth.uid() as uid')
      return rows[0]?.uid
    })
    expect(asService).toBeNull()
  })

  it('auth.role(), auth.jwt() and current_user follow the impersonated caller', async () => {
    const probe = async (as: Parameters<TestDb['asRole']>[0]) =>
      db.asRole(as, async (client) => {
        const { rows } = await client.query<{
          role: string | null
          jwt: Record<string, unknown> | null
          current_user: string
        }>('select auth.role() as role, auth.jwt() as jwt, current_user')
        return rows[0]
      })

    expect(await probe('visitor')).toEqual({
      role: DB_ROLES.anon,
      jwt: { role: DB_ROLES.anon },
      current_user: DB_ROLES.anon,
    })
    expect(await probe('service')).toEqual({
      role: DB_ROLES.service_role,
      jwt: { role: DB_ROLES.service_role },
      current_user: DB_ROLES.service_role,
    })
    const asBob = await probe({ userId: bob, isAnonymous: true })
    expect(asBob?.role).toBe(DB_ROLES.authenticated)
    expect(asBob?.current_user).toBe(DB_ROLES.authenticated)
    expect(asBob?.jwt).toMatchObject({ sub: bob, is_anonymous: true, aud: 'authenticated' })
  })

  it('auth.email() reads the email claim like Supabase', async () => {
    const email = (as: Parameters<TestDb['asRole']>[0]) =>
      db.asRole(as, async (client) => {
        const { rows } = await client.query<{ email: string | null }>(
          'select auth.email() as email',
        )
        return rows[0]?.email
      })
    expect(await email({ userId: alice, claims: { email: 'alice@example.test' } })).toBe(
      'alice@example.test',
    )
    expect(await email({ userId: alice })).toBeNull()
    expect(await email('visitor')).toBeNull()
  })

  it('auth.jwt() is null outside a request (no claims set)', async () => {
    const { rows } = await db.sql.query<{ jwt: unknown; uid: unknown }>(
      'select auth.jwt() as jwt, auth.uid() as uid',
    )
    expect(rows[0]).toEqual({ jwt: null, uid: null })
  })

  it('auth.users stores test users with is_anonymous and a GoTrue-style confirmed_at', async () => {
    const guest = await db.createAuthUser({ isAnonymous: true })
    const { rows } = await db.sql.query<{
      id: string
      email: string | null
      is_anonymous: boolean
      confirmed_at: Date | null
    }>(
      'select id, email, is_anonymous, confirmed_at from auth.users where id = any($1::uuid[]) order by created_at, id',
      [[alice, guest]],
    )
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === alice)).toMatchObject({
      email: 'alice@example.test',
      is_anonymous: false,
      confirmed_at: null,
    })
    expect(rows.find((row) => row.id === guest)).toMatchObject({ email: null, is_anonymous: true })

    await db.sql.query(
      "update auth.users set email_confirmed_at = '2026-01-01T00:00:00Z' where id = $1",
      [alice],
    )
    const confirmed = await db.sql.query<{ confirmed_at: Date }>(
      'select confirmed_at from auth.users where id = $1',
      [alice],
    )
    expect(confirmed.rows[0]?.confirmed_at?.toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('enforces GoTrue uniqueness: one non-SSO user per email and per phone', async () => {
    await expect(db.createAuthUser({ email: 'alice@example.test' })).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
    })
    await expect(db.createAuthUser({ phone: '+14155550100' })).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
    })
    // Guests carry neither; any number of them coexist.
    const guests = [
      await db.createAuthUser({ isAnonymous: true }),
      await db.createAuthUser({ isAnonymous: true }),
    ]
    expect(new Set(guests).size).toBe(2)
  })

  describe('row level security on a probe table', () => {
    beforeAll(async () => {
      await db.sql.query(`
        create table public.probe_rls (id serial primary key, owner uuid not null, note text);
        alter table public.probe_rls enable row level security;
      `)
      await db.sql.query('insert into public.probe_rls (owner, note) values ($1, $2), ($3, $4)', [
        alice,
        'alice row',
        bob,
        'bob row',
      ])
    })

    it('anon cannot select without a grant', async () => {
      let failure: unknown
      try {
        await db.asRole('visitor', (client) => client.query('select * from public.probe_rls'))
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(pg.DatabaseError)
      expect((failure as pg.DatabaseError).code).toBe(PERMISSION_DENIED)
    })

    it('with a grant but no policy, anon and authenticated see nothing', async () => {
      await db.sql.query('grant select on public.probe_rls to anon, authenticated')
      const asVisitor = await db.asRole('visitor', async (client) => {
        const { rows } = await client.query('select * from public.probe_rls')
        return rows.length
      })
      expect(asVisitor).toBe(0)
      const asAlice = await db.asRole({ userId: alice }, async (client) => {
        const { rows } = await client.query('select * from public.probe_rls')
        return rows.length
      })
      expect(asAlice).toBe(0)
    })

    it('authenticated with an auth.uid() policy sees only its own rows', async () => {
      await db.sql.query(
        `create policy probe_rls_owner on public.probe_rls
           for select to authenticated using (owner = auth.uid())`,
      )
      const asAlice = await db.asRole({ userId: alice }, async (client) => {
        const { rows } = await client.query<{ note: string }>(
          'select note from public.probe_rls order by note',
        )
        return rows.map((row) => row.note)
      })
      expect(asAlice).toEqual(['alice row'])

      const asVisitor = await db.asRole('visitor', async (client) => {
        const { rows } = await client.query('select * from public.probe_rls')
        return rows.length
      })
      expect(asVisitor).toBe(0)

      // service_role is granted new public tables by default (0002) and bypasses RLS.
      const asService = await db.asRole('service', async (client) => {
        const { rows } = await client.query('select * from public.probe_rls')
        return rows.length
      })
      expect(asService).toBe(2)
    })

    it('service_role still needs a grant: revoking it yields permission denied', async () => {
      await db.sql.query('revoke all on public.probe_rls from service_role')
      let failure: unknown
      try {
        await db.asRole('service', (client) => client.query('select * from public.probe_rls'))
      } catch (error) {
        failure = error
      }
      expect((failure as pg.DatabaseError).code).toBe(PERMISSION_DENIED)
    })
  })

  describe('re-applying the shim to a migrated database', () => {
    it('is idempotent and never re-opens the 0002 privilege baseline', async () => {
      const ledgerBefore = await db.sql.query<{ name: string }>(
        'select name from public.earth_migrations order by name',
      )
      // What `psql -f supabase/tests/sql/supabase_shim.sql` would do on a local database.
      await db.sql.query(await readFile(SHIM_PATH, 'utf8'))

      const ledgerAfter = await db.sql.query<{ name: string }>(
        'select name from public.earth_migrations order by name',
      )
      expect(ledgerAfter.rows).toEqual(ledgerBefore.rows)

      // auth.users and its rows survived; the functions still resolve the caller.
      const { rows } = await db.sql.query<{ n: string }>(
        'select count(*)::text as n from auth.users where id in ($1, $2)',
        [alice, bob],
      )
      expect(rows[0]?.n).toBe('2')
      const uid = await db.asRole({ userId: alice }, async (client) => {
        const result = await client.query<{ uid: string }>('select auth.uid() as uid')
        return result.rows[0]?.uid
      })
      expect(uid).toBe(alice)

      // Block 5's permissive defaults must not come back: new objects in public stay closed.
      await db.sql.query(`
        create table public.probe_reapply (id serial primary key);
        create function public.probe_reapply_fn() returns integer language sql as $$ select 1 $$;
      `)
      for (const role of [DB_ROLES.anon, DB_ROLES.authenticated]) {
        const table = await db.sql.query<{ ok: boolean }>(
          `select has_table_privilege($1, 'public.probe_reapply', 'SELECT') as ok`,
          [role],
        )
        expect(table.rows[0]?.ok, `${role} table`).toBe(false)
        const fn = await db.sql.query<{ ok: boolean }>(
          `select has_function_privilege($1, 'public.probe_reapply_fn()', 'EXECUTE') as ok`,
          [role],
        )
        expect(fn.rows[0]?.ok, `${role} function`).toBe(false)
        const seq = await db.sql.query<{ ok: boolean }>(
          `select has_sequence_privilege($1, 'public.probe_reapply_id_seq', 'USAGE') as ok`,
          [role],
        )
        expect(seq.rows[0]?.ok, `${role} sequence`).toBe(false)
      }
      const service = await db.sql.query<{ ok: boolean }>(
        `select has_table_privilege('service_role', 'public.probe_reapply', 'SELECT') as ok`,
      )
      expect(service.rows[0]?.ok).toBe(true)
    })
  })
})
