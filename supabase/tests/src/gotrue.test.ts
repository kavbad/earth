/**
 * GoTrue interop (ARCHITECTURE §15; shim header).
 *
 * The local stack applies GoTrue's own migrations before the shim (scripts/local-stack/up.sh:
 * prepare-db → `gotrue migrate` → scripts/db/migrate.ts). With KEEP_DB=1, or after a bare
 * `pnpm db:reset`, GoTrue instead migrates on top of the shim's auth.users. Both orders must yield a
 * working database, so both are run here against GoTrue's real migration files (fetched into
 * .local/gotrue/migrations by scripts/local-stack/fetch-binaries.sh, or EARTH_GOTRUE_MIGRATIONS_DIR).
 * Skipped loudly when the files are absent.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resetDatabase, type Logger } from '../../../scripts/db/migrate-core'
import {
  DATABASE_SEARCH_PATH,
  REPO_ROOT,
  migrateDatabase,
  setDatabaseSearchPath,
} from '../../../scripts/db/migrate-lib'
import { DB_ROLES, claimsFor, createTestDb, type TestDb } from './harness'
import {
  adminUrlFromEnv,
  connectAdmin,
  databaseUrl,
  dropDatabase,
  scratchDatabaseName,
} from './template'

const GOTRUE_MIGRATIONS_DIR_ENV = 'EARTH_GOTRUE_MIGRATIONS_DIR'
const DEFAULT_GOTRUE_MIGRATIONS_DIR = path.join(REPO_ROOT, '.local', 'gotrue', 'migrations')
/** GoTrue's namespace (GOTRUE_DB_NAMESPACE default), templated into its SQL files. */
const AUTH_SCHEMA = 'auth'
const NAMESPACE_TEMPLATE = /\{\{\s*index\s+\.Options\s+"Namespace"\s*\}\}/g
const UP_SUFFIX = '.up.sql'
/** GoTrue 2.185 ships 65 up-migrations; a much shorter list means a broken fetch. */
const MIN_GOTRUE_MIGRATIONS = 50

/** Columns GoTrue adds over time that the shim's subset does not carry. */
const GOTRUE_ONLY_COLUMNS = [
  'banned_until',
  'reauthentication_token',
  'reauthentication_sent_at',
  'email_change_token_current',
  'email_change_confirm_status',
  'phone_change',
  'phone_change_token',
] as const

const silent: Logger = { info: () => undefined }

interface ColumnRow {
  column_name: string
  data_type: string
  is_generated: string
}

const migrationsDir = process.env[GOTRUE_MIGRATIONS_DIR_ENV] ?? DEFAULT_GOTRUE_MIGRATIONS_DIR
const available = existsSync(migrationsDir)
if (!available) {
  console.warn(
    `[gotrue.test] ${migrationsDir} not found: run scripts/local-stack/fetch-binaries.sh or set ` +
      `${GOTRUE_MIGRATIONS_DIR_ENV}; skipping GoTrue interop tests`,
  )
}

async function listGotrueMigrations(dir: string): Promise<string[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(UP_SUFFIX)).sort()
  return names.map((name) => path.join(dir, name))
}

/**
 * Applies every up-migration the way `gotrue migrate` does: namespace substituted, the session
 * search_path set to `auth` (scripts/local-stack/env.sh), one transaction per file.
 */
async function applyGotrueMigrations(db: pg.Client, files: readonly string[]): Promise<void> {
  await db.query(`set search_path to ${AUTH_SCHEMA}`)
  try {
    for (const file of files) {
      const sql = (await readFile(file, 'utf8')).replace(NAMESPACE_TEMPLATE, AUTH_SCHEMA)
      await db.query('begin')
      try {
        await db.query(sql)
        await db.query('commit')
      } catch (error) {
        await db.query('rollback').catch(() => undefined)
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`GoTrue migration ${path.basename(file)} failed: ${detail}`)
      }
    }
  } finally {
    await db.query(`set search_path to ${DATABASE_SEARCH_PATH}`)
  }
}

async function userColumns(db: pg.Client): Promise<ColumnRow[]> {
  const { rows } = await db.query<ColumnRow>(
    `select column_name, data_type, is_generated
       from information_schema.columns
      where table_schema = $1 and table_name = 'users'
      order by column_name`,
    [AUTH_SCHEMA],
  )
  return rows
}

async function indexNames(db: pg.Client): Promise<string[]> {
  const { rows } = await db.query<{ indexname: string }>(
    `select indexname from pg_indexes where schemaname = $1 and tablename = 'users' order by indexname`,
    [AUTH_SCHEMA],
  )
  return rows.map((row) => row.indexname)
}

/** auth.uid() as an impersonated authenticated caller, on a raw client. */
async function uidAs(db: pg.Client, userId: string): Promise<string | null> {
  await db.query('begin')
  try {
    await db.query(`set local role ${DB_ROLES.authenticated}`)
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(claimsFor({ userId })),
    ])
    const { rows } = await db.query<{ uid: string | null }>('select auth.uid() as uid')
    return rows[0]?.uid ?? null
  } finally {
    await db.query('rollback')
  }
}

async function anonTablePrivilege(db: pg.Client, table: string): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(
    `select has_table_privilege($1, $2, 'SELECT') as ok`,
    [DB_ROLES.anon, table],
  )
  return rows[0]?.ok ?? true
}

describe.skipIf(!available)('GoTrue interop', () => {
  let files: string[]

  beforeAll(async () => {
    files = await listGotrueMigrations(migrationsDir)
    expect(files.length).toBeGreaterThanOrEqual(MIN_GOTRUE_MIGRATIONS)
  })

  describe('GoTrue first, then shim + migrations (the local stack order)', () => {
    const adminUrl = adminUrlFromEnv()
    const name = scratchDatabaseName()
    let admin: pg.Client
    let db: pg.Client

    beforeAll(async () => {
      admin = await connectAdmin(adminUrl)
      await resetDatabase(admin, name)
      await setDatabaseSearchPath(admin, name)
      db = new pg.Client({ connectionString: databaseUrl(adminUrl, name) })
      await db.connect()
      // scripts/local-stack/prepare-db.ts
      await db.query(`create schema if not exists ${AUTH_SCHEMA}`)
    })

    afterAll(async () => {
      await db.end().catch(() => undefined)
      await dropDatabase(admin, name)
      await admin.end()
    })

    it('applies GoTrue, then the shim and migrations, leaving GoTrue’s auth.users untouched', async () => {
      await applyGotrueMigrations(db, files)
      const columnsBefore = await userColumns(db)
      const indexesBefore = await indexNames(db)
      expect(columnsBefore.map((c) => c.column_name)).toEqual(
        expect.arrayContaining([
          'confirmed_at',
          'is_anonymous',
          'is_sso_user',
          ...GOTRUE_ONLY_COLUMNS,
        ]),
      )
      expect(columnsBefore.find((c) => c.column_name === 'email')?.data_type).toBe(
        'character varying',
      )

      const result = await migrateDatabase(db, silent)
      expect(result.shim).toBe('applied')
      expect(result.migrations.skipped).toEqual([])
      expect(result.migrations.applied.length).toBeGreaterThanOrEqual(5)

      expect(await userColumns(db)).toEqual(columnsBefore)
      expect(await indexNames(db)).toEqual(indexesBefore)

      // GoTrue’s functions were replaced by equivalent definitions; auth.email() survives.
      const fns = await db.query<{ uid: boolean; jwt: boolean; email: boolean }>(
        `select to_regprocedure('auth.uid()') is not null as uid,
                to_regprocedure('auth.jwt()') is not null as jwt,
                to_regprocedure('auth.email()') is not null as email`,
      )
      expect(fns.rows[0]).toEqual({ uid: true, jwt: true, email: true })

      // A harness-style user works against the real table, and the caller model resolves.
      const { rows } = await db.query<{ id: string }>(
        `insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
                                 is_anonymous, created_at, updated_at)
         values (gen_random_uuid(), 'authenticated', 'authenticated', 'gotrue-first@example.test',
                 '{}'::jsonb, '{}'::jsonb, false, now(), now())
         returning id`,
      )
      const userId = rows[0]?.id
      expect(userId).toBeDefined()
      expect(await uidAs(db, userId ?? '')).toBe(userId)

      // The privilege baseline holds here too, and re-running the runner is a no-op.
      await db.query('create table public.probe_gotrue_first (id int)')
      expect(await anonTablePrivilege(db, 'public.probe_gotrue_first')).toBe(false)
      expect(await anonTablePrivilege(db, 'auth.users')).toBe(false)
      const again = await migrateDatabase(db, silent)
      expect(again.shim).toBe('already_applied')
      expect(again.migrations.applied).toEqual([])
    })
  })

  describe('shim + migrations first, then GoTrue (KEEP_DB=1, or after pnpm db:reset)', () => {
    let db: TestDb
    let alice: string

    beforeAll(async () => {
      db = await createTestDb()
      alice = await db.createAuthUser({ email: 'alice@example.test', phone: '+14155550100' })
    })

    afterAll(async () => {
      await db.drop()
    })

    it('applies every GoTrue migration on top of the shim’s table and keeps Earth working', async () => {
      const ledgerBefore = await db.sql.query<{ name: string }>(
        'select name from public.earth_migrations order by name',
      )

      await applyGotrueMigrations(db.sql, files)

      const columns = await userColumns(db.sql)
      const names = columns.map((c) => c.column_name)
      expect(names).toEqual(
        expect.arrayContaining([
          'confirmed_at',
          'is_anonymous',
          'deleted_at',
          ...GOTRUE_ONLY_COLUMNS,
        ]),
      )
      expect(columns.find((c) => c.column_name === 'confirmed_at')?.is_generated).toBe('ALWAYS')
      expect(columns.find((c) => c.column_name === 'phone')?.data_type).toBe('text')

      // GoTrue’s uniqueness is present exactly once (the shim pre-created it under GoTrue’s names).
      const indexes = await indexNames(db.sql)
      for (const index of [
        'users_email_partial_key',
        'users_phone_key',
        'users_instance_id_email_idx',
        'users_instance_id_idx',
        'users_is_anonymous_idx',
        'confirmation_token_idx',
      ]) {
        expect(
          indexes.filter((name) => name === index),
          index,
        ).toHaveLength(1)
      }
      const dupes = await db.sql.query<{ ok: boolean }>(
        `select count(*) filter (where indexdef ilike '%unique%' and indexdef ilike '%(email)%') = 1 as ok
           from pg_indexes where schemaname = $1 and tablename = 'users'`,
        [AUTH_SCHEMA],
      )
      expect(dupes.rows[0]?.ok).toBe(true)

      // GoTrue’s tables reference the same users table; the existing row survived.
      const identities = await db.sql.query<{ reg: string | null }>(
        `select to_regclass('auth.identities') as reg`,
      )
      expect(identities.rows[0]?.reg).toBe('auth.identities')
      const users = await db.sql.query<{ n: string }>(
        'select count(*)::text as n from auth.users where id = $1',
        [alice],
      )
      expect(users.rows[0]?.n).toBe('1')

      // GoTrue replaced auth.uid()/role()/jwt() with its own (equivalent) definitions.
      const uid = await db.asRole({ userId: alice }, async (client) => {
        const { rows } = await client.query<{ uid: string | null }>('select auth.uid() as uid')
        return rows[0]?.uid
      })
      expect(uid).toBe(alice)
      const asVisitor = await db.asRole('visitor', async (client) => {
        const { rows } = await client.query<{ role: string | null; jwt: unknown }>(
          'select auth.role() as role, auth.jwt() as jwt',
        )
        return rows[0]
      })
      expect(asVisitor).toEqual({ role: DB_ROLES.anon, jwt: { role: DB_ROLES.anon } })

      // Earth is intact: ledger, helpers, privilege baseline.
      const ledgerAfter = await db.sql.query<{ name: string }>(
        'select name from public.earth_migrations order by name',
      )
      expect(ledgerAfter.rows).toEqual(ledgerBefore.rows)
      const helpers = await db.sql.query<{ ok: boolean }>(
        `select earth.utc_now() is not null and earth.is_service_role() as ok`,
      )
      expect(helpers.rows[0]?.ok).toBe(true)
      await db.sql.query('create table public.probe_gotrue_after (id int)')
      expect(await anonTablePrivilege(db.sql, 'public.probe_gotrue_after')).toBe(false)
      expect(await anonTablePrivilege(db.sql, 'auth.users')).toBe(false)
    })
  })
})
