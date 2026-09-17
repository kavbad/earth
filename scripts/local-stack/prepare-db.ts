#!/usr/bin/env tsx
/**
 * Prepares the local stack database before the services start (scripts/local-stack/up.sh).
 *
 * Drops and recreates the database empty (or keeps an existing one with --keep), then creates the
 * `auth` schema GoTrue's migrations expect. up.sh then runs `gotrue migrate` (GoTrue owns the real
 * auth.users) and scripts/db/migrate.ts (shim + supabase/migrations + seeds); the shim never alters
 * an existing auth.users, so the local database matches hosted Supabase as closely as possible.
 *
 *   tsx scripts/local-stack/prepare-db.ts [--keep]      reads DATABASE_URL (default earth_local)
 */
import pg from 'pg'
import { pathToFileURL } from 'node:url'

import {
  DEFAULT_DATABASE_URL,
  adminDatabaseUrl,
  databaseNameFromUrl,
  quoteIdentifier,
  resetDatabase,
  type SqlRunner,
} from '../db/migrate-core'

/** GoTrue's namespace (GOTRUE_DB_NAMESPACE default). */
export const AUTH_SCHEMA = 'auth'

export const PREPARE_OUTCOMES = ['created', 'recreated', 'kept'] as const
export type PrepareOutcome = (typeof PREPARE_OUTCOMES)[number]

export interface PrepareOptions {
  /** Keep an existing database instead of recreating it. */
  keep: boolean
}

export interface CliArgs extends PrepareOptions {
  help: boolean
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { keep: false, help: false }
  for (const arg of argv) {
    switch (arg) {
      case '--keep':
        args.keep = true
        break
      case '--help':
      case '-h':
        args.help = true
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

export async function databaseExists(admin: SqlRunner, name: string): Promise<boolean> {
  const { rows } = await admin.query('select 1 as found from pg_database where datname = $1', [
    name,
  ])
  return rows.length > 0
}

/** Recreates `name` empty unless it exists and `keep` is set. Runs on the maintenance database. */
export async function prepareDatabase(
  admin: SqlRunner,
  name: string,
  options: PrepareOptions,
): Promise<PrepareOutcome> {
  const exists = await databaseExists(admin, name)
  if (exists && options.keep) return 'kept'
  await resetDatabase(admin, name)
  return exists ? 'recreated' : 'created'
}

/** GoTrue's migrations assume the schema exists (hosted Supabase creates it); idempotent. */
export async function ensureAuthSchema(db: SqlRunner): Promise<void> {
  await db.query(`create schema if not exists ${quoteIdentifier(AUTH_SCHEMA)}`)
}

export const USAGE =
  'usage: tsx scripts/local-stack/prepare-db.ts [--keep]   (DATABASE_URL selects the database)'

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv)
  if (args.help) {
    console.log(USAGE)
    return
  }
  const databaseUrl = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL
  const name = databaseNameFromUrl(databaseUrl)

  const admin = new pg.Client({ connectionString: adminDatabaseUrl(databaseUrl) })
  await admin.connect()
  let outcome: PrepareOutcome
  try {
    outcome = await prepareDatabase(admin, name, { keep: args.keep })
  } finally {
    await admin.end()
  }

  const db = new pg.Client({ connectionString: databaseUrl })
  await db.connect()
  try {
    await ensureAuthSchema(db)
  } finally {
    await db.end()
  }
  console.log(`[prepare-db] database ${name} ${outcome}; schema ${AUTH_SCHEMA} ready`)
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`[prepare-db] FAILED ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
