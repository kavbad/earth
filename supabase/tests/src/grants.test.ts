import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DB_ROLES, createTestDb, type TestDb } from './harness'

const PERMISSION_DENIED = '42501'
const API_ROLES = [DB_ROLES.anon, DB_ROLES.authenticated, DB_ROLES.service_role] as const
const CLIENT_ROLES = [DB_ROLES.anon, DB_ROLES.authenticated] as const
/** Postgres' PUBLIC pseudo-role, as has_*_privilege() spells it. */
const PUBLIC_ROLE = 'public'

/** earth.* helpers RLS policies may evaluate as the caller: read-only, side-effect free. */
const POLICY_HELPERS = [
  'earth.jwt_claims()',
  'earth.is_anonymous_jwt()',
  'earth.is_service_role()',
  'earth.utc_now()',
  'earth.request_headers()',
  'earth.client_address()',
] as const

/** earth.* functions only security definer RPCs (owner) and the service role may run. */
const OWNER_ONLY_HELPERS = [
  'earth.rate_limit(text, text, integer, integer)',
  'earth.rate_limit_for_caller(text, integer, integer)',
  'earth.rate_limit_prune(integer)',
] as const

async function schemaPrivilege(
  db: TestDb,
  role: string,
  schema: string,
  privilege: 'USAGE' | 'CREATE' = 'USAGE',
): Promise<boolean> {
  const { rows } = await db.sql.query<{ ok: boolean }>(
    'select has_schema_privilege($1, $2, $3) as ok',
    [role, schema, privilege],
  )
  return rows[0]?.ok ?? false
}

async function tablePrivileges(db: TestDb, role: string, table: string): Promise<string[]> {
  const { rows } = await db.sql.query<{ privilege: string }>(
    `select p.privilege
       from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as p(privilege)
      where has_table_privilege($1, $2, p.privilege)
      order by p.privilege`,
    [role, table],
  )
  return rows.map((row) => row.privilege)
}

async function functionPrivilege(db: TestDb, role: string, fn: string): Promise<boolean> {
  const { rows } = await db.sql.query<{ ok: boolean }>(
    'select has_function_privilege($1, $2, $3) as ok',
    [role, fn, 'EXECUTE'],
  )
  return rows[0]?.ok ?? false
}

async function sequencePrivilege(db: TestDb, role: string, sequence: string): Promise<boolean> {
  const { rows } = await db.sql.query<{ ok: boolean }>(
    'select has_sequence_privilege($1, $2, $3) as ok',
    [role, sequence, 'USAGE'],
  )
  return rows[0]?.ok ?? false
}

async function rlsEnabled(db: TestDb, table: string): Promise<boolean> {
  const { rows } = await db.sql.query<{ ok: boolean }>(
    'select relrowsecurity as ok from pg_class where oid = $1::regclass',
    [table],
  )
  return rows[0]?.ok ?? false
}

describe('privilege baseline (0002)', () => {
  let db: TestDb

  beforeAll(async () => {
    db = await createTestDb()
  })

  afterAll(async () => {
    await db.drop()
  })

  it('public is usable by the API roles but only the owner may create in it', async () => {
    for (const role of API_ROLES) expect(await schemaPrivilege(db, role, 'public'), role).toBe(true)
    for (const role of [...CLIENT_ROLES, PUBLIC_ROLE]) {
      expect(await schemaPrivilege(db, role, 'public', 'CREATE'), `${role} CREATE`).toBe(false)
    }
  })

  it('earth and private are closed to anon and authenticated', async () => {
    for (const role of CLIENT_ROLES) {
      expect(await schemaPrivilege(db, role, 'earth'), `${role} on earth`).toBe(false)
      expect(await schemaPrivilege(db, role, 'private'), `${role} on private`).toBe(false)
    }
    expect(await schemaPrivilege(db, DB_ROLES.service_role, 'earth')).toBe(true)
    expect(await schemaPrivilege(db, DB_ROLES.service_role, 'private')).toBe(false)
  })

  it('anon and authenticated cannot name earth.* directly', async () => {
    for (const as of ['visitor', { userId: '00000000-0000-0000-0000-000000000001' }] as const) {
      let failure: unknown
      try {
        await db.asRole(as, (client) => client.query('select earth.utc_now()'))
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(pg.DatabaseError)
      expect((failure as pg.DatabaseError).code).toBe(PERMISSION_DENIED)
    }
    const asService = await db.asRole('service', (client) => client.query('select earth.utc_now()'))
    expect(asService.rows).toHaveLength(1)
  })

  it('a new table in public gets no privileges for anon/authenticated, all for service_role', async () => {
    await db.sql.query('create table public.probe_grants (id serial primary key, note text)')
    for (const role of [...CLIENT_ROLES, PUBLIC_ROLE]) {
      expect(await tablePrivileges(db, role, 'public.probe_grants'), role).toEqual([])
    }
    expect(await tablePrivileges(db, DB_ROLES.service_role, 'public.probe_grants')).toEqual([
      'DELETE',
      'INSERT',
      'REFERENCES',
      'SELECT',
      'TRIGGER',
      'TRUNCATE',
      'UPDATE',
    ])
    // Sequences behind serial columns follow the same rule.
    for (const role of CLIENT_ROLES) {
      expect(await sequencePrivilege(db, role, 'public.probe_grants_id_seq'), role).toBe(false)
    }
    expect(await sequencePrivilege(db, DB_ROLES.service_role, 'public.probe_grants_id_seq')).toBe(
      true,
    )
  })

  it('a new function in public is not executable by anon/authenticated until granted', async () => {
    await db.sql.query(
      `create function public.probe_fn() returns integer language sql as $$ select 1 $$`,
    )
    for (const role of [...CLIENT_ROLES, PUBLIC_ROLE]) {
      expect(await functionPrivilege(db, role, 'public.probe_fn()'), role).toBe(false)
    }
    expect(await functionPrivilege(db, DB_ROLES.service_role, 'public.probe_fn()')).toBe(true)

    let failure: unknown
    try {
      await db.asRole('visitor', (client) => client.query('select public.probe_fn()'))
    } catch (error) {
      failure = error
    }
    expect((failure as pg.DatabaseError).code).toBe(PERMISSION_DENIED)

    await db.sql.query('grant execute on function public.probe_fn() to anon')
    const asVisitor = await db.asRole('visitor', (client) =>
      client.query<{ probe_fn: number }>('select public.probe_fn()'),
    )
    expect(asVisitor.rows[0]?.probe_fn).toBe(1)
  })

  it('earth helpers stay callable from RLS policies evaluated as authenticated', async () => {
    // Policies check EXECUTE on the function, not USAGE on its schema (see 0002 header).
    expect(await functionPrivilege(db, DB_ROLES.authenticated, 'earth.jwt_claims()')).toBe(true)

    const owner = await db.createAuthUser()
    const other = await db.createAuthUser()
    await db.sql.query(`
      create table public.probe_policy (id serial primary key, owner_sub text not null);
      alter table public.probe_policy enable row level security;
      grant select on public.probe_policy to authenticated;
      create policy probe_policy_owner on public.probe_policy
        for select to authenticated using (owner_sub = (earth.jwt_claims() ->> 'sub'));
    `)
    await db.sql.query('insert into public.probe_policy (owner_sub) values ($1), ($2)', [
      owner,
      other,
    ])
    const visible = await db.asRole({ userId: owner }, async (client) => {
      const { rows } = await client.query<{ owner_sub: string }>(
        'select owner_sub from public.probe_policy',
      )
      return rows.map((row) => row.owner_sub)
    })
    expect(visible).toEqual([owner])
  })

  it('read-only helpers are executable by the API roles; rate limiting is owner/service only', async () => {
    for (const role of CLIENT_ROLES) {
      for (const fn of POLICY_HELPERS) {
        expect(await functionPrivilege(db, role, fn), `${role} ${fn}`).toBe(true)
      }
      for (const fn of OWNER_ONLY_HELPERS) {
        expect(await functionPrivilege(db, role, fn), `${role} ${fn}`).toBe(false)
      }
    }
    for (const fn of OWNER_ONLY_HELPERS) {
      expect(await functionPrivilege(db, PUBLIC_ROLE, fn), `public ${fn}`).toBe(false)
      expect(await functionPrivilege(db, DB_ROLES.service_role, fn), `service_role ${fn}`).toBe(
        true,
      )
    }
    // A security definer RPC owned by the migrating role still reaches them for any caller.
    await db.sql.query(`
      create function public.probe_limited() returns integer
      language sql security definer set search_path = public, earth, private, pg_temp
      as $$ select earth.rate_limit_for_caller('probe_limited', 2, 60) $$;
      grant execute on function public.probe_limited() to anon, authenticated;
    `)
    expect(await db.rpc('probe_limited', {}, 'visitor')).toBe(0)
  })

  it('the migration ledger, rate limit table and auth.users are locked down', async () => {
    expect(await rlsEnabled(db, 'public.earth_migrations')).toBe(true)
    expect(await rlsEnabled(db, 'private.rate_limits')).toBe(true)
    expect(await rlsEnabled(db, 'auth.users')).toBe(true)
    for (const role of CLIENT_ROLES) {
      expect(await tablePrivileges(db, role, 'public.earth_migrations'), role).toEqual([])
      expect(await tablePrivileges(db, role, 'auth.users'), role).toEqual([])
    }
    for (const role of API_ROLES) {
      expect(await tablePrivileges(db, role, 'private.rate_limits'), role).toEqual([])
    }
  })

  it('extensions live in the extensions schema, on the search_path, executable by the API roles', async () => {
    const { rows } = await db.sql.query<{ extname: string; nspname: string }>(
      `select e.extname, n.nspname
         from pg_extension e join pg_namespace n on n.oid = e.extnamespace
        where e.extname in ('postgis', 'pgcrypto', 'pg_trgm')
        order by e.extname`,
    )
    expect(rows).toEqual([
      { extname: 'pg_trgm', nspname: 'extensions' },
      { extname: 'pgcrypto', nspname: 'extensions' },
      { extname: 'postgis', nspname: 'extensions' },
    ])
    const searchPath = await db.sql.query<{ search_path: string }>('show search_path')
    expect(searchPath.rows[0]?.search_path).toContain('extensions')
    // RLS policies evaluated as the caller use PostGIS (audience by area) and pgcrypto.
    await db.sql.query(
      `create function extensions.probe_ext() returns integer language sql as $$ select 1 $$`,
    )
    for (const role of API_ROLES) {
      expect(await schemaPrivilege(db, role, 'extensions'), role).toBe(true)
      for (const fn of [
        'extensions.st_contains(extensions.geometry, extensions.geometry)',
        'extensions.gen_random_bytes(integer)',
        'extensions.probe_ext()',
      ]) {
        expect(await functionPrivilege(db, role, fn), `${role} ${fn}`).toBe(true)
      }
    }
  })
})
