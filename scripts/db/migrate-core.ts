/**
 * Pure building blocks of the migration runner (scripts/db/migrate.ts). Nothing here reads
 * process.env or the filesystem so every function is unit-testable; the CLI wires them up.
 */

export const DEFAULT_DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:5432/earth_local'
export const MIGRATIONS_TABLE = 'earth_migrations'
export const ADMIN_DATABASE = 'postgres'
export const SQL_EXTENSION = '.sql'
export const SHIM_RECORD_PREFIX = 'shim:'
export const PRODUCTION_APP_ENV = 'production'

export interface MigrateOptions {
  reset: boolean
  seed: boolean
  noSeed: boolean
  help: boolean
}

export interface SqlFile {
  /** Basename, e.g. `0001_extensions.sql`. Recorded in the migrations table. */
  name: string
  /** Absolute path to read. */
  path: string
}

/** The subset of `pg.Client` the runner needs; keeps tests free of a live connection. */
export interface SqlRunner {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }>
}

export interface Logger {
  info(message: string): void
}

export class MigrationError extends Error {
  readonly file: string

  constructor(file: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`Migration failed in ${file}: ${detail}`)
    this.name = 'MigrationError'
    this.file = file
    this.cause = cause
  }
}

export function parseArgs(argv: readonly string[]): MigrateOptions {
  const options: MigrateOptions = { reset: false, seed: false, noSeed: false, help: false }
  for (const arg of argv) {
    switch (arg) {
      case '--reset':
        options.reset = true
        break
      case '--seed':
        options.seed = true
        break
      case '--no-seed':
        options.noSeed = true
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

/**
 * Seeds are applied when explicitly requested, or on `--reset` outside production
 * (ARCHITECTURE.md §15) unless `--no-seed` is given.
 */
export function shouldSeed(options: MigrateOptions, appEnv: string | undefined): boolean {
  if (options.noSeed) return false
  if (options.seed) return true
  return options.reset && appEnv !== PRODUCTION_APP_ENV
}

/**
 * `--reset` drops the database. It is refused outright when APP_ENV=production: the seed guard
 * (shouldSeed) is not enough, since a reset against a production DATABASE_URL destroys data first.
 */
export function assertResetAllowed(options: MigrateOptions, appEnv: string | undefined): void {
  if (options.reset && appEnv === PRODUCTION_APP_ENV) {
    throw new Error(`--reset drops the database and is refused when APP_ENV=${PRODUCTION_APP_ENV}`)
  }
}

export function databaseNameFromUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl)
  const name = decodeURIComponent(url.pathname.replace(/^\//, ''))
  if (!name) throw new Error(`DATABASE_URL has no database name: ${databaseUrl}`)
  return name
}

/** Same host/credentials, pointed at the maintenance database so we can drop/create. */
export function adminDatabaseUrl(databaseUrl: string, adminDatabase = ADMIN_DATABASE): string {
  const url = new URL(databaseUrl)
  url.pathname = `/${adminDatabase}`
  return url.toString()
}

/** Double-quoted identifier with embedded quotes escaped. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** Keeps only `.sql` files and orders them lexically so `0001_` runs before `0002_`. */
export function orderSqlFiles(names: readonly string[]): string[] {
  return names
    .filter((name) => name.endsWith(SQL_EXTENSION))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export async function resetDatabase(admin: SqlRunner, databaseName: string): Promise<void> {
  const ident = quoteIdentifier(databaseName)
  await admin.query(`drop database if exists ${ident} with (force)`)
  await admin.query(`create database ${ident}`)
}

export async function ensureMigrationsTable(db: SqlRunner): Promise<void> {
  await db.query(
    `create table if not exists public.${MIGRATIONS_TABLE} (
      name text primary key,
      applied_at timestamptz not null default now()
    )`,
  )
}

export async function appliedMigrations(db: SqlRunner): Promise<Set<string>> {
  const { rows } = await db.query(`select name from public.${MIGRATIONS_TABLE}`)
  return new Set(rows.map((row) => String(row['name'])))
}

/**
 * Runs one SQL file inside a transaction and records it under `recordAs` (when given).
 * Rolls back and throws `MigrationError` naming the file on any failure.
 */
export async function applySqlFile(
  db: SqlRunner,
  file: SqlFile,
  sql: string,
  recordAs: string | null,
): Promise<void> {
  await db.query('begin')
  try {
    await db.query(sql)
    if (recordAs !== null) {
      await db.query(`insert into public.${MIGRATIONS_TABLE} (name) values ($1)`, [recordAs])
    }
    await db.query('commit')
  } catch (error) {
    try {
      await db.query('rollback')
    } catch {
      // The original error is what matters; a failed rollback means the connection is gone.
    }
    throw new MigrationError(file.name, error)
  }
}

export interface MigrationResult {
  applied: string[]
  skipped: string[]
}

export async function runMigrations(
  db: SqlRunner,
  files: readonly SqlFile[],
  readSql: (file: SqlFile) => Promise<string>,
  logger: Logger,
  recordPrefix = '',
): Promise<MigrationResult> {
  await ensureMigrationsTable(db)
  const done = await appliedMigrations(db)
  const result: MigrationResult = { applied: [], skipped: [] }
  for (const file of files) {
    const record = `${recordPrefix}${file.name}`
    if (done.has(record)) {
      result.skipped.push(file.name)
      continue
    }
    logger.info(`applying ${file.name}`)
    await applySqlFile(db, file, await readSql(file), record)
    result.applied.push(file.name)
  }
  return result
}

/** Seeds are re-runnable fixtures: applied every time, never recorded. */
export async function runSeeds(
  db: SqlRunner,
  files: readonly SqlFile[],
  readSql: (file: SqlFile) => Promise<string>,
  logger: Logger,
): Promise<string[]> {
  const applied: string[] = []
  for (const file of files) {
    logger.info(`seeding ${file.name}`)
    await applySqlFile(db, file, await readSql(file), null)
    applied.push(file.name)
  }
  return applied
}
