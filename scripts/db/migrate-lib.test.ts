import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DEFAULT_DATABASE_URL,
  MIGRATIONS_TABLE,
  SHIM_RECORD_PREFIX,
  adminDatabaseUrl,
  duplicateMigrationVersions,
  quoteIdentifier,
  resetDatabase,
  type Logger,
  type SqlRunner,
} from './migrate-core'
import {
  DATABASE_SEARCH_PATH,
  MIGRATIONS_DIR,
  SHIM_PATH,
  SUPABASE_MANAGED_ROLE,
  isSupabaseManaged,
  listSqlFiles,
  migrateDatabase,
  setDatabaseSearchPath,
} from './migrate-lib'

const silent: Logger = { info: () => undefined }

class FakeDb implements SqlRunner {
  readonly statements: string[] = []
  readonly applied = new Set<string>()
  managed = false

  async query(text: string, values?: readonly unknown[]) {
    this.statements.push(text)
    if (text.includes('to_regprocedure')) {
      expect(values?.[0]).toBe(SUPABASE_MANAGED_ROLE)
      return { rows: [{ managed: this.managed }] }
    }
    if (text.startsWith(`select name from public.${MIGRATIONS_TABLE}`)) {
      return { rows: [...this.applied].map((name) => ({ name })) }
    }
    if (text.startsWith(`insert into public.${MIGRATIONS_TABLE}`)) {
      this.applied.add(String(values?.[0]))
    }
    return { rows: [] }
  }
}

describe('repository layout', () => {
  it('points at the migrations directory and the shim', async () => {
    expect(MIGRATIONS_DIR.endsWith(path.join('supabase', 'migrations'))).toBe(true)
    expect(SHIM_PATH.endsWith(path.join('supabase', 'tests', 'sql', 'supabase_shim.sql'))).toBe(
      true,
    )
    const names = (await listSqlFiles(MIGRATIONS_DIR)).map((f) => f.name)
    expect(names).toContain('0001_extensions.sql')
    expect(names).toEqual([...names].sort())
  })

  // `supabase db push` (.github/workflows/deploy.yml) records each file under the digits before its
  // first underscore, and `supabase_migrations.schema_migrations.version` is a primary key: two
  // files sharing a prefix abort the hosted push part-way through the schema. This runner's ledger
  // is keyed on the whole filename (migrate-core.ts `name text primary key`), so only this assertion
  // catches it.
  it('gives every migration a version prefix no other migration claims', async () => {
    const names = (await listSqlFiles(MIGRATIONS_DIR)).map((f) => f.name)
    expect(names.length).toBeGreaterThan(0)
    expect(duplicateMigrationVersions(names)).toEqual([])
  })

  it('returns no files for a missing directory', async () => {
    expect(await listSqlFiles('/does/not/exist')).toEqual([])
  })
})

describe('isSupabaseManaged', () => {
  it('reads the managed flag', async () => {
    const db = new FakeDb()
    expect(await isSupabaseManaged(db)).toBe(false)
    db.managed = true
    expect(await isSupabaseManaged(db)).toBe(true)
  })
})

describe('migrateDatabase (fake runner)', () => {
  let migrationsDir: string
  let shimPath: string

  beforeAll(async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'earth-migrate-lib-'))
    migrationsDir = path.join(dir, 'migrations')
    await mkdir(migrationsDir)
    shimPath = path.join(dir, 'supabase_shim.sql')
    await writeFile(shimPath, 'select 1')
    await writeFile(path.join(migrationsDir, '0001_a.sql'), 'select 1')
    await writeFile(path.join(migrationsDir, '0002_b.sql'), 'select 1')
    await writeFile(path.join(migrationsDir, 'notes.md'), 'ignored')
  })

  afterAll(async () => {
    await rm(path.dirname(shimPath), { recursive: true, force: true })
  })

  it('sets the search path, applies the shim under its prefix, then the migrations', async () => {
    const db = new FakeDb()
    const result = await migrateDatabase(db, silent, { migrationsDir, shimPath })
    expect(db.statements[0]).toBe(`set search_path to ${DATABASE_SEARCH_PATH}`)
    expect(result.shim).toBe('applied')
    expect(result.migrations).toEqual({ applied: ['0001_a.sql', '0002_b.sql'], skipped: [] })
    expect([...db.applied]).toEqual([
      `${SHIM_RECORD_PREFIX}supabase_shim.sql`,
      '0001_a.sql',
      '0002_b.sql',
    ])
  })

  it('reports an already applied shim and skips recorded migrations', async () => {
    const db = new FakeDb()
    db.applied.add(`${SHIM_RECORD_PREFIX}supabase_shim.sql`)
    db.applied.add('0001_a.sql')
    const result = await migrateDatabase(db, silent, { migrationsDir, shimPath })
    expect(result.shim).toBe('already_applied')
    expect(result.migrations).toEqual({ applied: ['0002_b.sql'], skipped: ['0001_a.sql'] })
  })

  it('never applies the shim on a Supabase-managed database', async () => {
    const db = new FakeDb()
    db.managed = true
    const result = await migrateDatabase(db, silent, { migrationsDir, shimPath })
    expect(result.shim).toBe('skipped_managed')
    expect([...db.applied]).toEqual(['0001_a.sql', '0002_b.sql'])
  })

  it('reports a missing or disabled shim', async () => {
    const missing = await migrateDatabase(new FakeDb(), silent, {
      migrationsDir,
      shimPath: path.join(migrationsDir, 'nope.sql'),
    })
    expect(missing.shim).toBe('missing')
    const disabled = await migrateDatabase(new FakeDb(), silent, { migrationsDir, shimPath: null })
    expect(disabled.shim).toBe('missing')
  })

  it('quotes the database name when persisting the search path', async () => {
    const db = new FakeDb()
    await setDatabaseSearchPath(db, 'we"ird')
    expect(db.statements[0]).toBe(
      `alter database ${quoteIdentifier('we"ird')} set search_path = ${DATABASE_SEARCH_PATH}`,
    )
  })
})

// Integration: the real shim + migrations on the local Postgres. Skipped (loudly) when unreachable.
const baseUrl = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL
const scratchName = `earth_migrate_lib_test_${process.pid}_${Date.now()}`
const scratchUrl = (() => {
  const url = new URL(baseUrl)
  url.pathname = `/${scratchName}`
  return url.toString()
})()

async function canConnect(): Promise<boolean> {
  const client = new pg.Client({
    connectionString: adminDatabaseUrl(baseUrl),
    connectionTimeoutMillis: 2000,
  })
  try {
    await client.connect()
    return true
  } catch (error) {
    console.warn(
      `[migrate-lib.test] Postgres unreachable, skipping integration test: ${String(error)}`,
    )
    return false
  } finally {
    await client.end().catch(() => undefined)
  }
}

const postgresAvailable = await canConnect()

describe.skipIf(!postgresAvailable)('migrateDatabase (real Postgres)', () => {
  let admin: pg.Client

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminDatabaseUrl(baseUrl) })
    await admin.connect()
    await resetDatabase(admin, scratchName)
    await setDatabaseSearchPath(admin, scratchName)
  }, 60_000)

  afterAll(async () => {
    await admin.query(`drop database if exists ${quoteIdentifier(scratchName)} with (force)`)
    await admin.end()
  })

  it('applies the shim and the real migrations, and is a no-op on re-run', async () => {
    const db = new pg.Client({ connectionString: scratchUrl })
    await db.connect()
    try {
      const first = await migrateDatabase(db, silent)
      expect(first.shim).toBe('applied')
      expect(first.migrations.applied.length).toBeGreaterThanOrEqual(5)
      expect(first.migrations.skipped).toEqual([])

      const again = await migrateDatabase(db, silent)
      expect(again.shim).toBe('already_applied')
      expect(again.migrations.applied).toEqual([])

      const ledger = await db.query<{ name: string }>(
        `select name from public.${MIGRATIONS_TABLE} order by name`,
      )
      const names = ledger.rows.map((row) => row.name)
      expect(names).toContain(`${SHIM_RECORD_PREFIX}supabase_shim.sql`)
      expect(names).toContain('0001_extensions.sql')

      const probe = await db.query<{
        has_uid: boolean
        has_rate_limit: boolean
        search_path: string
      }>(
        `select to_regprocedure('auth.uid()') is not null as has_uid,
                to_regprocedure('earth.rate_limit(text,text,integer,integer)') is not null as has_rate_limit,
                current_setting('search_path') as search_path`,
      )
      expect(probe.rows[0]).toMatchObject({ has_uid: true, has_rate_limit: true })
      expect(probe.rows[0]?.search_path).toContain('extensions')
    } finally {
      await db.end()
    }
  }, 120_000)
})
