/**
 * Shared migration entry points used by the CLI (scripts/db/migrate.ts) and the database test
 * harness (supabase/tests/src/template.ts), so both apply the Supabase shim and the migrations with
 * exactly the same logic and ledger (public.earth_migrations).
 *
 * migrate-core.ts holds the pure building blocks; this module knows the repository layout.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SHIM_RECORD_PREFIX,
  orderSqlFiles,
  quoteIdentifier,
  runMigrations,
  type Logger,
  type MigrationResult,
  type SqlFile,
  type SqlRunner,
} from './migrate-core'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations')
export const SEED_DIR = path.join(REPO_ROOT, 'supabase', 'seed')
export const SHIM_PATH = path.join(REPO_ROOT, 'supabase', 'tests', 'sql', 'supabase_shim.sql')

/**
 * Search path applied to local databases and to the migrating session: mirrors PostgREST's
 * `extra_search_path` (supabase/config.toml) and the hosted `postgres` role, where extensions
 * (postgis, pgcrypto) live in the `extensions` schema.
 */
export const DATABASE_SEARCH_PATH = 'public, extensions'

/** A role only real Supabase (hosted or `supabase start`) has; the shim never creates it. */
export const SUPABASE_MANAGED_ROLE = 'supabase_auth_admin'

export const SHIM_OUTCOMES = ['applied', 'already_applied', 'skipped_managed', 'missing'] as const
export type ShimOutcome = (typeof SHIM_OUTCOMES)[number]

export interface MigrateDatabaseOptions {
  /** Directory of `NNNN_name.sql` files. Defaults to supabase/migrations. */
  migrationsDir?: string
  /** Shim file to apply first; `null` disables the shim. Defaults to supabase/tests/sql/supabase_shim.sql. */
  shimPath?: string | null
}

export interface MigrateDatabaseResult {
  shim: ShimOutcome
  migrations: MigrationResult
}

export async function listSqlFiles(dir: string): Promise<SqlFile[]> {
  if (!existsSync(dir)) return []
  const names = orderSqlFiles(await readdir(dir))
  return names.map((name) => ({ name, path: path.join(dir, name) }))
}

export const readSql = (file: SqlFile): Promise<string> => readFile(file.path, 'utf8')

/**
 * True when the connected database is managed by Supabase: the `supabase_auth_admin` role exists
 * and `auth.uid()` is already defined. The compatibility shim must never be applied there.
 */
export async function isSupabaseManaged(db: SqlRunner): Promise<boolean> {
  const { rows } = await db.query(
    `select exists (select 1 from pg_roles where rolname = $1)
        and to_regprocedure('auth.uid()') is not null as managed`,
    [SUPABASE_MANAGED_ROLE],
  )
  return rows[0]?.['managed'] === true
}

/**
 * Applies the Supabase shim (unless the database is Supabase-managed or the file is absent), then
 * every pending migration in lexical order, each in its own transaction, recording names in
 * public.earth_migrations. The session search_path is set to DATABASE_SEARCH_PATH first so
 * migrations resolve extension types exactly as on hosted Supabase.
 */
export async function migrateDatabase(
  db: SqlRunner,
  logger: Logger,
  options: MigrateDatabaseOptions = {},
): Promise<MigrateDatabaseResult> {
  const migrationsDir = options.migrationsDir ?? MIGRATIONS_DIR
  const shimPath = options.shimPath === undefined ? SHIM_PATH : options.shimPath

  await db.query(`set search_path to ${DATABASE_SEARCH_PATH}`)

  let shim: ShimOutcome = 'missing'
  if (shimPath !== null && existsSync(shimPath)) {
    if (await isSupabaseManaged(db)) {
      shim = 'skipped_managed'
      logger.info('supabase shim skipped: Supabase-managed database detected')
    } else {
      const file: SqlFile = { name: path.basename(shimPath), path: shimPath }
      const result = await runMigrations(db, [file], readSql, logger, SHIM_RECORD_PREFIX)
      shim = result.applied.length > 0 ? 'applied' : 'already_applied'
    }
  }

  const migrations = await runMigrations(db, await listSqlFiles(migrationsDir), readSql, logger)
  return { shim, migrations }
}

/**
 * Persists DATABASE_SEARCH_PATH on a database so every new connection (tests, PostgREST, psql) sees
 * `extensions` like the hosted project does. Database-level settings are not copied by
 * `create database ... template`, so this runs for every scratch database as well.
 */
export async function setDatabaseSearchPath(admin: SqlRunner, databaseName: string): Promise<void> {
  await admin.query(
    `alter database ${quoteIdentifier(databaseName)} set search_path = ${DATABASE_SEARCH_PATH}`,
  )
}
