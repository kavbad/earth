import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DB_ROLES,
  assertIdentifier,
  claimsFor,
  createTestDb,
  roleFor,
  unwrapRpcResult,
  type TestDb,
} from './harness'
import { SCRATCH_PREFIX, TEMPLATE_DATABASE, scratchDatabaseName } from './template'

describe('pure helpers', () => {
  it('maps callers to database roles and claims', () => {
    expect(roleFor('visitor')).toBe(DB_ROLES.anon)
    expect(roleFor('service')).toBe(DB_ROLES.service_role)
    expect(roleFor({ userId: 'u1' })).toBe(DB_ROLES.authenticated)
    expect(claimsFor('visitor')).toEqual({ role: DB_ROLES.anon })
    expect(claimsFor('service')).toEqual({ role: DB_ROLES.service_role })
    expect(claimsFor({ userId: 'u1' })).toEqual({
      role: DB_ROLES.authenticated,
      aud: 'authenticated',
      sub: 'u1',
      is_anonymous: false,
    })
    expect(claimsFor({ userId: 'u1', isAnonymous: true, claims: { email: 'x@y' } })).toMatchObject({
      sub: 'u1',
      is_anonymous: true,
      email: 'x@y',
    })
  })

  it('rejects unsafe identifiers', () => {
    expect(() => assertIdentifier('group_create', 'rpc name')).not.toThrow()
    expect(() => assertIdentifier('Group', 'rpc name')).toThrow(/snake_case/)
    expect(() => assertIdentifier('x; drop table', 'rpc name')).toThrow(/snake_case/)
  })

  it('generates unique scratch names within the identifier limit', () => {
    const a = scratchDatabaseName()
    const b = scratchDatabaseName()
    expect(a).not.toBe(b)
    for (const name of [a, b]) {
      expect(name.startsWith(SCRATCH_PREFIX)).toBe(true)
      expect(name.length).toBeLessThanOrEqual(63)
      expect(name).toMatch(/^[a-z0-9_]+$/)
    }
  })

  it('unwraps single-value results and keeps row sets', () => {
    const single = { fields: [{ name: 'f' }], rows: [{ f: { a: 1 } }] } as unknown as pg.QueryResult
    expect(unwrapRpcResult(single)).toEqual({ a: 1 })
    const many = {
      fields: [{ name: 'f' }],
      rows: [{ f: 1 }, { f: 2 }],
    } as unknown as pg.QueryResult
    expect(unwrapRpcResult(many)).toEqual([1, 2])
    const wide = {
      fields: [{ name: 'a' }, { name: 'b' }],
      rows: [{ a: 1, b: 2 }],
    } as unknown as pg.QueryResult
    expect(unwrapRpcResult(wide)).toEqual([{ a: 1, b: 2 }])
  })
})

describe('createTestDb', () => {
  let db: TestDb

  beforeAll(async () => {
    db = await createTestDb()
    await db.sql.query(`
      create table public.probe_harness (id serial primary key, note text not null);
      grant select, insert on public.probe_harness to authenticated;
      grant usage on sequence public.probe_harness_id_seq to authenticated;

      create function public.probe_echo(a integer, b text) returns jsonb
      language sql security definer set search_path = public, earth, private, pg_temp
      as $$ select jsonb_build_object('a', a, 'b', b, 'caller', auth.uid()) $$;
      grant execute on function public.probe_echo(integer, text) to anon, authenticated;

      create function public.probe_fail(code text) returns jsonb
      language plpgsql security definer set search_path = public, earth, private, pg_temp
      as $$ begin perform earth.raise(code); return '{}'::jsonb; end $$;
      grant execute on function public.probe_fail(text) to anon, authenticated;

      create function public.probe_rows() returns table (n integer, label text)
      language sql security definer set search_path = public, earth, private, pg_temp
      as $$ select * from (values (1, 'one'), (2, 'two')) as v(n, label) $$;
      grant execute on function public.probe_rows() to anon;
    `)
  })

  afterAll(async () => {
    await db.drop()
  })

  it('clones a migrated template with the shim recorded', async () => {
    expect(db.name.startsWith(SCRATCH_PREFIX)).toBe(true)
    const { rows } = await db.sql.query<{ name: string }>(
      'select name from public.earth_migrations order by name',
    )
    const names = rows.map((row) => row.name)
    expect(names).toContain('shim:supabase_shim.sql')
    expect(names.slice(0, 5)).toEqual([
      '0001_extensions.sql',
      '0002_schemas.sql',
      '0003_enums.sql',
      '0004_helpers.sql',
      '0005_rate_limits.sql',
    ])
  })

  it('createAuthUser inserts distinct users', async () => {
    const a = await db.createAuthUser({ email: 'a@example.test' })
    const b = await db.createAuthUser()
    expect(a).not.toBe(b)
    const { rows } = await db.sql.query<{ n: string }>(
      'select count(*)::text as n from auth.users where id in ($1, $2)',
      [a, b],
    )
    expect(rows[0]?.n).toBe('2')
  })

  it('asRole commits by default, rolls back on request or error', async () => {
    const user = await db.createAuthUser()
    const seen = await db.asRole({ userId: user }, async (client) => {
      await client.query("insert into public.probe_harness (note) values ('kept')")
      const { rows } = await client.query<{ current_user: string; claims: string }>(
        "select current_user, current_setting('request.jwt.claims', true) as claims",
      )
      return rows[0]
    })
    expect(seen?.current_user).toBe(DB_ROLES.authenticated)
    expect(JSON.parse(seen?.claims ?? '{}')).toMatchObject({ sub: user })

    await db.asRole(
      { userId: user },
      (client) => client.query("insert into public.probe_harness (note) values ('rolled back')"),
      { rollback: true },
    )

    await expect(
      db.asRole({ userId: user }, async (client) => {
        await client.query("insert into public.probe_harness (note) values ('errored')")
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const { rows } = await db.sql.query<{ note: string }>(
      'select note from public.probe_harness order by id',
    )
    expect(rows.map((row) => row.note)).toEqual(['kept'])
  })

  it('leaves no role or claims behind on the pooled connection', async () => {
    await db.asRole('visitor', (client) => client.query('select 1'))
    const after = await db.asRole('service', async (client) => {
      const { rows } = await client.query<{ current_user: string }>('select current_user')
      return rows[0]?.current_user
    })
    expect(after).toBe(DB_ROLES.service_role)
    const { rows } = await db.sql.query<{ current_user: string; claims: string | null }>(
      "select current_user, nullif(current_setting('request.jwt.claims', true), '') as claims",
    )
    expect(rows[0]).toEqual({ current_user: 'postgres', claims: null })
  })

  it('rpc passes named arguments and unwraps jsonb results', async () => {
    const user = await db.createAuthUser()
    expect(await db.rpc('probe_echo', { b: 'x', a: 7 }, { userId: user })).toEqual({
      a: 7,
      b: 'x',
      caller: user,
    })
    expect(await db.rpc('probe_echo', { a: 1, b: 'v' }, 'visitor')).toEqual({
      a: 1,
      b: 'v',
      caller: null,
    })
    expect(await db.rpc('probe_rows', {}, 'visitor')).toEqual([
      { n: 1, label: 'one' },
      { n: 2, label: 'two' },
    ])
    await expect(db.rpc('probe echo', {}, 'visitor')).rejects.toThrow(/snake_case/)
  })

  it('expectError checks the machine code and errcode', async () => {
    const error = await db.expectError(
      db.rpc('probe_fail', { code: 'blocked' }, 'visitor'),
      'blocked',
    )
    expect(error).toBeInstanceOf(pg.DatabaseError)
    expect(error.code).toBe('P0001')

    await expect(
      db.expectError(db.rpc('probe_fail', { code: 'blocked' }, 'visitor'), 'not_a_member'),
    ).rejects.toThrow(/expected error "not_a_member" but got blocked/)
    await expect(
      db.expectError(db.rpc('probe_echo', { a: 1, b: 'x' }, 'visitor'), 'blocked'),
    ).rejects.toThrow(/succeeded/)
    await expect(
      db.expectError(
        db.asRole('visitor', () => Promise.reject(new Error('js'))),
        'blocked',
      ),
    ).rejects.toThrow(/non-Postgres error/)
    // A permission error is not a machine code either.
    await expect(
      db.expectError(
        db.asRole('visitor', (c) => c.query('select * from auth.users')),
        'forbidden',
      ),
    ).rejects.toThrow(/sqlstate 42501/)
  })

  it('runs role sessions concurrently on separate connections', async () => {
    const pids = await Promise.all(
      [1, 2, 3].map(() =>
        db.asRole('visitor', async (client) => {
          const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
          await client.query('select pg_sleep(0.1)')
          return rows[0]?.pid
        }),
      ),
    )
    expect(new Set(pids).size).toBe(3)
  })

  it('clones several scratch databases from the template concurrently', async () => {
    const clones = await Promise.all([createTestDb(), createTestDb()])
    try {
      for (const clone of clones) {
        const { rows } = await clone.sql.query('select 1 from public.earth_migrations')
        expect(rows.length).toBeGreaterThanOrEqual(6)
      }
    } finally {
      await Promise.all(clones.map((clone) => clone.drop()))
    }
    const { rows } = await db.sql.query<{ datname: string }>(
      'select datname from pg_database where datname = any($1::text[])',
      [clones.map((clone) => clone.name)],
    )
    expect(rows).toEqual([])
  })

  it('isolates every scratch database from the others and from the template', async () => {
    const [a, b] = await Promise.all([createTestDb(), createTestDb()])
    try {
      expect(a.name).not.toBe(b.name)
      await a.sql.query('create table public.probe_isolation (id int primary key)')
      const user = await a.createAuthUser({ email: 'only-in-a@example.test' })

      const inB = await b.sql.query<{ reg: string | null; users: string }>(
        `select to_regclass('public.probe_isolation') as reg,
                (select count(*)::text from auth.users) as users`,
      )
      expect(inB.rows[0]).toEqual({ reg: null, users: '0' })
      const inHere = await db.sql.query<{ reg: string | null; n: string }>(
        `select to_regclass('public.probe_isolation') as reg,
                (select count(*)::text from auth.users where id = $1) as n`,
        [user],
      )
      expect(inHere.rows[0]).toEqual({ reg: null, n: '0' })

      // The template stays pristine and closed to sessions, so clones never block on it.
      const template = await db.sql.query<{ datallowconn: boolean }>(
        'select datallowconn from pg_database where datname = $1',
        [TEMPLATE_DATABASE],
      )
      expect(template.rows[0]?.datallowconn).toBe(false)
    } finally {
      await Promise.all([a.drop(), b.drop()])
    }
  })
})
