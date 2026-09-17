/**
 * The hosted deploy path: `supabase db push` (.github/workflows/deploy.yml).
 *
 * A hosted Supabase project has no `public.earth_migrations`. The CLI records applied migrations in
 * `supabase_migrations.schema_migrations`; our ledger is created only by this repo's own runner
 * (scripts/db/migrate-core.ts `ensureMigrationsTable`) for the local stack and for these tests.
 * Every other database test therefore runs against a database where the runner already created that
 * table, which is exactly what hid a bare `revoke all on table public.earth_migrations` in
 * 0002_schemas.sql: `supabase db push` aborted on the second migration and deployed nothing.
 *
 * So this file applies supabase/migrations to a database that never gets the ledger, one
 * transaction per file in lexical order, the way the CLI does.
 */
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'

import { applySqlFile, resetDatabase, type SqlFile } from '../../../scripts/db/migrate-core'
import {
  DATABASE_SEARCH_PATH,
  MIGRATIONS_DIR,
  SHIM_PATH,
  listSqlFiles,
  readSql,
  setDatabaseSearchPath,
} from '../../../scripts/db/migrate-lib'
import {
  PROVIDED_ADMIN_URL,
  PROVIDED_TEMPLATE,
  adminUrlFromEnv,
  connectAdmin,
  databaseUrl,
  dropDatabase,
  runIdFromTemplate,
  scratchDatabaseName,
} from './template'

const UNDEFINED_TABLE = '42P01'

function injected<T>(key: Parameters<typeof inject>[0], fallback: T): T {
  try {
    return (inject(key) as T | undefined) ?? fallback
  } catch {
    // Outside a vitest worker: fall back to the environment.
    return fallback
  }
}

describe('supabase db push onto a project without the migration ledger', () => {
  const adminUrl = injected(PROVIDED_ADMIN_URL, adminUrlFromEnv())
  const name = scratchDatabaseName(runIdFromTemplate(injected(PROVIDED_TEMPLATE, '')) ?? undefined)
  let admin: pg.Client
  let db: pg.Client
  let migrations: SqlFile[]

  const ledger = async (): Promise<string | null> => {
    const { rows } = await db.query<{ ledger: string | null }>(
      `select to_regclass('public.earth_migrations')::text as ledger`,
    )
    return rows[0]?.ledger ?? null
  }

  beforeAll(async () => {
    admin = await connectAdmin(adminUrl)
    await resetDatabase(admin, name)
    await setDatabaseSearchPath(admin, name)
    db = new pg.Client({ connectionString: databaseUrl(adminUrl, name) })
    await db.connect()
    await db.query(`set search_path to ${DATABASE_SEARCH_PATH}`)
    // Stands in for the API roles, `auth` schema and `extensions` schema a hosted project already
    // has. It is not a migration and is never pushed; like hosted Supabase it creates no ledger.
    await db.query(await readSql({ name: 'supabase_shim.sql', path: SHIM_PATH }))
    migrations = await listSqlFiles(MIGRATIONS_DIR)
  })

  afterAll(async () => {
    await db.end()
    await dropDatabase(admin, name)
    await admin.end()
  })

  it('starts from a database with no public.earth_migrations, as hosted Supabase does', async () => {
    expect(await ledger()).toBeNull()
    expect(migrations.length).toBeGreaterThan(0)
    expect(migrations[0]?.name).toBe('0001_extensions.sql')
  })

  it('applies every migration, so no statement assumes the ledger exists', async () => {
    for (const file of migrations) {
      // `recordAs: null`: there is no ledger to record into, exactly as on a hosted push.
      await applySqlFile(db, file, await readSql(file), null)
    }

    // The push built the schema without ever creating the ledger.
    expect(await ledger()).toBeNull()
    const schemas = await db.query<{ nspname: string }>(
      `select nspname from pg_namespace where nspname in ('earth', 'private') order by nspname`,
    )
    expect(schemas.rows.map((row) => row.nspname)).toEqual(['earth', 'private'])
    const tables = await db.query<{ n: string }>(
      `select count(*)::text as n from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`,
    )
    expect(Number(tables.rows[0]?.n)).toBeGreaterThan(20)
  })

  it('would have failed on the unguarded revoke that aborted the push', async () => {
    // 0002 ran clean above; the same statement without the guard is still 42P01 here.
    await expect(
      db.query('revoke all on table public.earth_migrations from anon, authenticated'),
    ).rejects.toMatchObject({ code: UNDEFINED_TABLE })
  })

  it('takes the guarded branch and locks the ledger down when it does exist', async () => {
    await db.query(
      `create table public.earth_migrations (
         name text primary key, applied_at timestamptz not null default now())`,
    )
    await db.query('grant select on table public.earth_migrations to anon, authenticated')

    const file = migrations.find((entry) => entry.name === '0002_schemas.sql')
    expect(file?.name).toBe('0002_schemas.sql')
    await applySqlFile(db, file as SqlFile, await readSql(file as SqlFile), null)

    const grants = await db.query<{ grantee: string }>(
      `select distinct grantee from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'earth_migrations'
          and grantee in ('anon', 'authenticated')`,
    )
    expect(grants.rows).toEqual([])
    const rls = await db.query<{ rls: boolean }>(
      `select relrowsecurity as rls from pg_class where oid = 'public.earth_migrations'::regclass`,
    )
    expect(rls.rows[0]?.rls).toBe(true)
  })
})
