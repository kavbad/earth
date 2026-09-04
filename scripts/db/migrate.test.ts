import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DEFAULT_DATABASE_URL,
  MIGRATIONS_TABLE,
  MigrationError,
  adminDatabaseUrl,
  applySqlFile,
  assertResetAllowed,
  databaseNameFromUrl,
  duplicateMigrationVersions,
  migrationVersion,
  orderSqlFiles,
  parseArgs,
  quoteIdentifier,
  resetDatabase,
  runMigrations,
  runSeeds,
  shouldSeed,
  type Logger,
  type SqlFile,
  type SqlRunner,
} from './migrate-core'

const silent: Logger = { info: () => undefined }

describe('parseArgs', () => {
  it('parses the supported flags', () => {
    expect(parseArgs([])).toEqual({ reset: false, seed: false, noSeed: false, help: false })
    expect(parseArgs(['--reset', '--seed'])).toMatchObject({ reset: true, seed: true })
    expect(parseArgs(['--no-seed'])).toMatchObject({ noSeed: true })
    expect(parseArgs(['-h'])).toMatchObject({ help: true })
  })

  it('rejects unknown arguments', () => {
    expect(() => parseArgs(['--drop-everything'])).toThrow(/Unknown argument/)
  })
})

describe('shouldSeed', () => {
  it('seeds on reset outside production', () => {
    expect(shouldSeed(parseArgs(['--reset']), 'development')).toBe(true)
    expect(shouldSeed(parseArgs(['--reset']), undefined)).toBe(true)
    expect(shouldSeed(parseArgs(['--reset']), 'production')).toBe(false)
  })

  it('honours explicit flags', () => {
    expect(shouldSeed(parseArgs(['--seed']), 'production')).toBe(true)
    expect(shouldSeed(parseArgs(['--reset', '--no-seed']), 'development')).toBe(false)
    expect(shouldSeed(parseArgs([]), 'development')).toBe(false)
  })
})

describe('assertResetAllowed', () => {
  it('refuses --reset in production and allows it elsewhere', () => {
    expect(() => assertResetAllowed(parseArgs(['--reset']), 'production')).toThrow(/refused/)
    expect(() => assertResetAllowed(parseArgs(['--reset', '--no-seed']), 'production')).toThrow(
      /refused/,
    )
    expect(() => assertResetAllowed(parseArgs(['--reset']), 'development')).not.toThrow()
    expect(() => assertResetAllowed(parseArgs(['--reset']), undefined)).not.toThrow()
    expect(() => assertResetAllowed(parseArgs(['--seed']), 'production')).not.toThrow()
    expect(() => assertResetAllowed(parseArgs([]), 'production')).not.toThrow()
  })
})

describe('url helpers', () => {
  it('extracts the database name', () => {
    expect(databaseNameFromUrl(DEFAULT_DATABASE_URL)).toBe('earth_local')
    expect(
      databaseNameFromUrl('postgresql://u:p@db.example.com:6543/my%20db?sslmode=require'),
    ).toBe('my db')
    expect(() => databaseNameFromUrl('postgres://u:p@localhost:5432/')).toThrow(/no database name/)
  })

  it('re-targets the maintenance database keeping credentials and query', () => {
    expect(adminDatabaseUrl('postgres://u:p@localhost:5432/earth_local?sslmode=disable')).toBe(
      'postgres://u:p@localhost:5432/postgres?sslmode=disable',
    )
  })

  it('quotes identifiers safely', () => {
    expect(quoteIdentifier('earth_local')).toBe('"earth_local"')
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"')
  })
})

describe('migration versions', () => {
  it('reads the version the Supabase CLI keys its ledger on', () => {
    expect(migrationVersion('0001_extensions.sql')).toBe('0001')
    expect(migrationVersion('0965_fix_messaging_blocked_direct_read_state.sql')).toBe('0965')
    expect(() => migrationVersion('supabase_shim.sql')).toThrow(/numeric version/)
  })

  it('reports every version claimed by more than one file', () => {
    expect(duplicateMigrationVersions(['0001_a.sql', '0002_b.sql'])).toEqual([])
    expect(
      duplicateMigrationVersions(['0951_a.sql', '0951_b.sql', '0961_c.sql', '0961_d.sql']),
    ).toEqual(['0951', '0961'])
  })
})

describe('orderSqlFiles', () => {
  it('keeps only .sql files in lexical order', () => {
    expect(
      orderSqlFiles(['0100_identity.sql', 'README.md', '0001_extensions.sql', '.gitkeep']),
    ).toEqual(['0001_extensions.sql', '0100_identity.sql'])
  })
})

class FakeDb implements SqlRunner {
  readonly statements: string[] = []
  readonly applied = new Set<string>()
  failOn: string | null = null

  async query(text: string, values?: readonly unknown[]) {
    this.statements.push(text)
    if (this.failOn !== null && text.includes(this.failOn)) throw new Error(`boom: ${this.failOn}`)
    if (text.startsWith(`select name from public.${MIGRATIONS_TABLE}`)) {
      return { rows: [...this.applied].map((name) => ({ name })) }
    }
    if (text.startsWith(`insert into public.${MIGRATIONS_TABLE}`)) {
      this.applied.add(String(values?.[0]))
    }
    return { rows: [] }
  }
}

const file = (name: string): SqlFile => ({ name, path: `/virtual/${name}` })
const sqlFor = async (f: SqlFile) => `-- ${f.name}\nselect 1`

describe('runMigrations (fake runner)', () => {
  it('applies pending files in transactions and skips recorded ones', async () => {
    const db = new FakeDb()
    db.applied.add('0001_a.sql')
    const result = await runMigrations(db, [file('0001_a.sql'), file('0002_b.sql')], sqlFor, silent)
    expect(result).toEqual({ applied: ['0002_b.sql'], skipped: ['0001_a.sql'] })
    expect(db.statements).toContain('begin')
    expect(db.statements).toContain('commit')
    expect(db.applied.has('0002_b.sql')).toBe(true)
  })

  it('records shim files under the prefix', async () => {
    const db = new FakeDb()
    await runMigrations(db, [file('supabase_shim.sql')], sqlFor, silent, 'shim:')
    expect(db.applied.has('shim:supabase_shim.sql')).toBe(true)
  })

  it('rolls back and names the failing file', async () => {
    const db = new FakeDb()
    db.failOn = '0002_b.sql'
    await expect(
      runMigrations(db, [file('0001_a.sql'), file('0002_b.sql')], sqlFor, silent),
    ).rejects.toMatchObject({ name: 'MigrationError', file: '0002_b.sql' })
    expect(db.statements.at(-1)).toBe('rollback')
    expect(db.applied.has('0002_b.sql')).toBe(false)
  })

  it('never records seeds', async () => {
    const db = new FakeDb()
    const applied = await runSeeds(db, [file('seed.sql')], sqlFor, silent)
    expect(applied).toEqual(['seed.sql'])
    expect(db.applied.size).toBe(0)
  })

  it('wraps errors from applySqlFile', async () => {
    const db = new FakeDb()
    db.failOn = 'select 1'
    await expect(applySqlFile(db, file('x.sql'), 'select 1', 'x.sql')).rejects.toBeInstanceOf(
      MigrationError,
    )
  })
})

// Integration: a real scratch database on the local Postgres. Skipped (loudly) when the
// server is unreachable so unit tests still run on machines without Postgres.
const baseUrl = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL
const scratchName = `earth_migrate_test_${process.pid}_${Date.now()}`
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
    console.warn(`[migrate.test] Postgres unreachable, skipping integration test: ${String(error)}`)
    return false
  } finally {
    await client.end().catch(() => undefined)
  }
}

const postgresAvailable = await canConnect()

describe.skipIf(!postgresAvailable)('runMigrations (real Postgres)', () => {
  let dir: string
  let admin: pg.Client

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'earth-migrate-'))
    await writeFile(path.join(dir, '0001_first.sql'), 'create table first (id int primary key);')
    await writeFile(
      path.join(dir, '0002_second.sql'),
      'create table second (id int primary key); insert into first values (1);',
    )
    admin = new pg.Client({ connectionString: adminDatabaseUrl(baseUrl) })
    await admin.connect()
    await resetDatabase(admin, scratchName)
  }, 60_000)

  afterAll(async () => {
    await admin.query(`drop database if exists ${quoteIdentifier(scratchName)} with (force)`)
    await admin.end()
    await rm(dir, { recursive: true, force: true })
  })

  it('applies, records, skips on re-run, and rolls back a failing file', async () => {
    const files = ['0001_first.sql', '0002_second.sql'].map((name) => ({
      name,
      path: path.join(dir, name),
    }))
    const readSql = async (f: SqlFile) =>
      (await import('node:fs/promises')).readFile(f.path, 'utf8')

    const db = new pg.Client({ connectionString: scratchUrl })
    await db.connect()
    try {
      const first = await runMigrations(db, files, readSql, silent)
      expect(first).toEqual({ applied: files.map((f) => f.name), skipped: [] })

      const again = await runMigrations(db, files, readSql, silent)
      expect(again).toEqual({ applied: [], skipped: files.map((f) => f.name) })

      const recorded = await db.query(`select name from public.${MIGRATIONS_TABLE} order by name`)
      expect(recorded.rows.map((r: { name: string }) => r.name)).toEqual(files.map((f) => f.name))

      const bad = { name: '0003_bad.sql', path: path.join(dir, '0003_bad.sql') }
      await writeFile(bad.path, 'create table third (id int); select * from does_not_exist;')
      await expect(runMigrations(db, [...files, bad], readSql, silent)).rejects.toMatchObject({
        file: '0003_bad.sql',
      })
      const third = await db.query(`select to_regclass('public.third') as reg`)
      expect(third.rows[0]?.['reg']).toBeNull()
    } finally {
      await db.end()
    }
  }, 60_000)
})
