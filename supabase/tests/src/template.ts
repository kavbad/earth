/**
 * Template database lifecycle for the database tests (ARCHITECTURE §15).
 *
 * Once per vitest run (vitest.globalSetup.ts) the template is built by applying the Supabase shim and
 * every migration with the same runner the CLI uses (scripts/db/migrate-lib.ts). Each test file then
 * clones it with `create database ... template earth_test_template`, which takes well under a second
 * even with PostGIS installed. Nothing in this module imports vitest so the global setup (main
 * process) and the harness (worker processes) share it.
 */
import pg from 'pg'

import {
  adminDatabaseUrl,
  quoteIdentifier,
  resetDatabase,
  type Logger,
} from '../../../scripts/db/migrate-core'
import {
  migrateDatabase,
  setDatabaseSearchPath,
  type MigrateDatabaseResult,
} from '../../../scripts/db/migrate-lib'

/** Superuser connection to the maintenance database; scratch databases are created next to it. */
export const ADMIN_URL_ENV = 'EARTH_TEST_ADMIN_URL'
export const DEFAULT_ADMIN_URL = 'postgres://postgres:postgres@127.0.0.1:5432/postgres'
export const TEMPLATE_DATABASE = 'earth_test_template'
export const SCRATCH_PREFIX = 'earth_test_scratch_'

/** Keys handed from the global setup to test workers through vitest's provide/inject. */
export const PROVIDED_ADMIN_URL = 'earthTestAdminUrl'
export const PROVIDED_TEMPLATE = 'earthTestTemplate'

declare module 'vitest' {
  export interface ProvidedContext {
    [PROVIDED_ADMIN_URL]: string
    [PROVIDED_TEMPLATE]: string
  }
}

export function adminUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[ADMIN_URL_ENV]
  if (explicit) return explicit
  const databaseUrl = env['DATABASE_URL']
  if (databaseUrl) return adminDatabaseUrl(databaseUrl)
  return DEFAULT_ADMIN_URL
}

/** Same server and credentials as `adminUrl`, pointed at `databaseName`. */
export function databaseUrl(adminUrl: string, databaseName: string): string {
  const url = new URL(adminUrl)
  url.pathname = `/${databaseName}`
  return url.toString()
}

export async function connectAdmin(adminUrl: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: adminUrl })
  await client.connect()
  return client
}

export async function listDatabasesWithPrefix(admin: pg.Client, prefix: string): Promise<string[]> {
  const { rows } = await admin.query<{ datname: string }>(
    'select datname from pg_database where left(datname, length($1)) = $1 order by datname',
    [prefix],
  )
  return rows.map((row) => row.datname)
}

export async function dropDatabase(admin: pg.Client, name: string): Promise<void> {
  await admin.query(`drop database if exists ${quoteIdentifier(name)} with (force)`)
}

export async function dropDatabasesWithPrefix(admin: pg.Client, prefix: string): Promise<string[]> {
  const names = await listDatabasesWithPrefix(admin, prefix)
  for (const name of names) await dropDatabase(admin, name)
  return names
}

/**
 * Drops leftovers from earlier runs, recreates the template, applies shim + migrations, then
 * closes the template to connections so clones never wait on a stray session.
 */
export async function buildTemplate(
  adminUrl: string,
  logger: Logger,
  templateName = TEMPLATE_DATABASE,
): Promise<MigrateDatabaseResult> {
  const admin = await connectAdmin(adminUrl)
  try {
    const leftovers = await dropDatabasesWithPrefix(admin, SCRATCH_PREFIX)
    if (leftovers.length > 0)
      logger.info(`dropped ${leftovers.length} leftover scratch database(s)`)

    await resetDatabase(admin, templateName)
    await setDatabaseSearchPath(admin, templateName)

    const db = new pg.Client({ connectionString: databaseUrl(adminUrl, templateName) })
    await db.connect()
    let result: MigrateDatabaseResult
    try {
      result = await migrateDatabase(db, logger)
    } finally {
      await db.end()
    }

    await admin.query(
      `alter database ${quoteIdentifier(templateName)} with allow_connections false`,
    )
    return result
  } finally {
    await admin.end()
  }
}

/** Drops every scratch database and the template. */
export async function destroyTemplate(
  adminUrl: string,
  templateName = TEMPLATE_DATABASE,
): Promise<void> {
  const admin = await connectAdmin(adminUrl)
  try {
    await dropDatabasesWithPrefix(admin, SCRATCH_PREFIX)
    await dropDatabase(admin, templateName)
  } finally {
    await admin.end()
  }
}

let scratchCounter = 0

/** Unique (per process and per call) database name under the 63-byte identifier limit. */
export function scratchDatabaseName(now = Date.now()): string {
  scratchCounter += 1
  const random = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0')
  return `${SCRATCH_PREFIX}${now.toString(36)}_${process.pid}_${scratchCounter}_${random}`
}

export async function createScratchDatabase(
  admin: pg.Client,
  name: string,
  templateName = TEMPLATE_DATABASE,
): Promise<void> {
  await admin.query(
    `create database ${quoteIdentifier(name)} template ${quoteIdentifier(templateName)}`,
  )
  await setDatabaseSearchPath(admin, name)
}
