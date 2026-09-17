import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { DEFAULT_DATABASE_URL, adminDatabaseUrl, type SqlRunner } from '../db/migrate-core'
import {
  AUTH_SCHEMA,
  databaseExists,
  ensureAuthSchema,
  parseArgs,
  prepareDatabase,
} from './prepare-db'

describe('parseArgs', () => {
  it('parses --keep and --help and rejects anything else', () => {
    expect(parseArgs([])).toEqual({ keep: false, help: false })
    expect(parseArgs(['--keep'])).toEqual({ keep: true, help: false })
    expect(parseArgs(['-h'])).toMatchObject({ help: true })
    expect(() => parseArgs(['--drop'])).toThrow(/Unknown argument/)
  })
})

/** Records queries and answers the existence probe from `exists`. */
function fakeAdmin(exists: boolean): { runner: SqlRunner; queries: string[] } {
  const queries: string[] = []
  const runner: SqlRunner = {
    query: async (text) => {
      queries.push(text)
      if (text.includes('pg_database')) return { rows: exists ? [{ found: 1 }] : [] }
      return { rows: [] }
    },
  }
  return { runner, queries }
}

describe('prepareDatabase (fake runner)', () => {
  it('keeps an existing database when asked', async () => {
    const { runner, queries } = fakeAdmin(true)
    await expect(prepareDatabase(runner, 'earth_local', { keep: true })).resolves.toBe('kept')
    expect(queries).toHaveLength(1)
  })

  it('recreates an existing database by default', async () => {
    const { runner, queries } = fakeAdmin(true)
    await expect(prepareDatabase(runner, 'earth_local', { keep: false })).resolves.toBe('recreated')
    expect(queries.slice(1)).toEqual([
      'drop database if exists "earth_local" with (force)',
      'create database "earth_local"',
    ])
  })

  it('creates a missing database even with --keep', async () => {
    const { runner, queries } = fakeAdmin(false)
    await expect(prepareDatabase(runner, 'earth_local', { keep: true })).resolves.toBe('created')
    expect(queries).toContain('create database "earth_local"')
  })
})

const adminUrl = adminDatabaseUrl(process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL)

/** Same convention as scripts/db/migrate.test.ts: the integration block needs a reachable Postgres. */
async function postgresReachable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 2_000 })
  try {
    await client.connect()
    await client.end()
    return true
  } catch (error) {
    console.warn(
      `[prepare-db.test] Postgres unreachable, skipping integration test: ${String(error)}`,
    )
    return false
  }
}

const postgresAvailable = await postgresReachable()

describe.skipIf(!postgresAvailable)('prepareDatabase (Postgres)', () => {
  const name = `earth_prepare_test_${process.pid}`
  let admin: pg.Client

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl })
    await admin.connect()
    await admin.query(`drop database if exists "${name}" with (force)`)
  })

  afterAll(async () => {
    await admin.query(`drop database if exists "${name}" with (force)`)
    await admin.end()
  })

  it('creates, keeps, recreates, and prepares the auth schema', async () => {
    await expect(databaseExists(admin, name)).resolves.toBe(false)
    await expect(prepareDatabase(admin, name, { keep: false })).resolves.toBe('created')
    await expect(databaseExists(admin, name)).resolves.toBe(true)

    const url = new URL(adminUrl)
    url.pathname = `/${name}`
    const db = new pg.Client({ connectionString: url.toString() })
    await db.connect()
    try {
      await db.query('create table keep_me (id int)')
      await ensureAuthSchema(db)
      await ensureAuthSchema(db)
      const { rows } = await db.query('select nspname from pg_namespace where nspname = $1', [
        AUTH_SCHEMA,
      ])
      expect(rows).toHaveLength(1)
    } finally {
      await db.end()
    }

    await expect(prepareDatabase(admin, name, { keep: true })).resolves.toBe('kept')
    await expect(prepareDatabase(admin, name, { keep: false })).resolves.toBe('recreated')

    const fresh = new pg.Client({ connectionString: url.toString() })
    await fresh.connect()
    try {
      const { rows } = await fresh.query("select to_regclass('public.keep_me') as table")
      expect(rows[0]?.['table']).toBeNull()
    } finally {
      await fresh.end()
    }
  })
})
