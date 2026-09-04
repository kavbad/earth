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
/** Base template name; each vitest run uses `runTemplateName()` so concurrent runs never collide. */
export const TEMPLATE_DATABASE = 'earth_tt_base'
export const TEMPLATE_PREFIX = 'earth_tt_'
export const SCRATCH_PREFIX = 'earth_ts_'
/** Every database name created by the harness starts with this (templates and scratch clones). */
export const TEST_DATABASE_PREFIX = 'earth_t'

const processRunId = `${Date.now().toString(36)}${process.pid.toString(36)}`

/** Identifier shared by one vitest run: its template and every scratch clone carry it. */
export function currentRunId(): string {
  return process.env['EARTH_TEST_RUN_ID'] ?? processRunId
}

export function runTemplateName(runId = currentRunId()): string {
  return `${TEMPLATE_PREFIX}${runId}`
}

/** The run id encoded in a template name, or null for a template not created by `runTemplateName`. */
export function runIdFromTemplate(templateName: string): string | null {
  return templateName.startsWith(TEMPLATE_PREFIX)
    ? templateName.slice(TEMPLATE_PREFIX.length)
    : null
}

export function scratchPrefixFor(runId: string): string {
  return `${SCRATCH_PREFIX}${runId}_`
}

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
 * Recreates this run's template, applies shim + migrations, then closes the template to
 * connections so clones never wait on a stray session. Other runs' databases are never touched
 * (several test runs may share one Postgres); use `cleanupAllTestDatabases` for stale leftovers.
 */
export async function buildTemplate(
  adminUrl: string,
  logger: Logger,
  templateName = TEMPLATE_DATABASE,
): Promise<MigrateDatabaseResult> {
  const admin = await connectAdmin(adminUrl)
  try {
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

/** Drops this run's scratch databases and its template; other runs are left alone. */
export async function destroyTemplate(
  adminUrl: string,
  templateName = TEMPLATE_DATABASE,
): Promise<void> {
  const admin = await connectAdmin(adminUrl)
  try {
    const runId = runIdFromTemplate(templateName)
    await dropDatabasesWithPrefix(admin, runId === null ? SCRATCH_PREFIX : scratchPrefixFor(runId))
    await dropDatabase(admin, templateName)
  } finally {
    await admin.end()
  }
}

/** Drops every harness database (all runs): for `pnpm db:test:clean` after crashed runs. */
export async function cleanupAllTestDatabases(adminUrl: string): Promise<string[]> {
  const admin = await connectAdmin(adminUrl)
  try {
    return await dropDatabasesWithPrefix(admin, TEST_DATABASE_PREFIX)
  } finally {
    await admin.end()
  }
}

let scratchCounter = 0

/** Unique (per run, process and call) database name under the 63-byte identifier limit. */
export function scratchDatabaseName(runId = currentRunId()): string {
  scratchCounter += 1
  const random = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0')
  return `${scratchPrefixFor(runId)}${process.pid.toString(36)}_${scratchCounter}_${random}`
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
