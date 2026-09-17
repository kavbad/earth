#!/usr/bin/env tsx
/**
 * Earth database migration runner.
 *
 *   tsx scripts/db/migrate.ts            apply pending supabase/migrations/*.sql
 *   tsx scripts/db/migrate.ts --reset    drop + recreate the database first (seeds; refused when APP_ENV=production)
 *   tsx scripts/db/migrate.ts --seed     also apply supabase/seed/*.sql
 *   tsx scripts/db/migrate.ts --no-seed  never apply seeds
 *
 * Reads DATABASE_URL (default postgres://postgres:postgres@127.0.0.1:5432/earth_local).
 * Applies supabase/tests/sql/supabase_shim.sql first on a plain Postgres (never on a Supabase-managed
 * database), then each migration in its own transaction, recording names in public.earth_migrations
 * so re-runs skip applied files. Exits non-zero naming the failing file. The same logic backs the
 * database test harness through scripts/db/migrate-lib.ts.
 */
import { config as loadDotenv } from 'dotenv'
import path from 'node:path'
import pg from 'pg'

import {
  DEFAULT_DATABASE_URL,
  MigrationError,
  adminDatabaseUrl,
  assertResetAllowed,
  databaseNameFromUrl,
  parseArgs,
  resetDatabase,
  runSeeds,
  shouldSeed,
  type Logger,
} from './migrate-core'
import {
  REPO_ROOT,
  SEED_DIR,
  isSupabaseManaged,
  listSqlFiles,
  migrateDatabase,
  readSql,
  setDatabaseSearchPath,
} from './migrate-lib'

const logger: Logger = {
  info: (message) => console.log(`[db] ${message}`),
}

function printHelp(): void {
  console.log(
    [
      'usage: tsx scripts/db/migrate.ts [--reset] [--seed] [--no-seed]',
      '',
      '  --reset    drop and recreate the database before migrating',
      '  --seed     apply supabase/seed/*.sql after migrating',
      '  --no-seed  never apply seeds (overrides the --reset default outside production)',
      '',
      `DATABASE_URL defaults to ${DEFAULT_DATABASE_URL}`,
    ].join('\n'),
  )
}

async function main(argv: readonly string[]): Promise<void> {
  loadDotenv({ path: path.join(REPO_ROOT, '.env'), quiet: true })
  const options = parseArgs(argv)
  if (options.help) {
    printHelp()
    return
  }

  const appEnv = process.env['APP_ENV']
  assertResetAllowed(options, appEnv)

  const databaseUrl = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL
  const databaseName = databaseNameFromUrl(databaseUrl)

  if (options.reset) {
    const admin = new pg.Client({ connectionString: adminDatabaseUrl(databaseUrl) })
    await admin.connect()
    try {
      logger.info(`resetting database ${databaseName}`)
      await resetDatabase(admin, databaseName)
    } finally {
      await admin.end()
    }
  }

  const db = new pg.Client({ connectionString: databaseUrl })
  await db.connect()
  try {
    if (!(await isSupabaseManaged(db))) {
      await setDatabaseSearchPath(db, databaseName)
    }

    const result = await migrateDatabase(db, logger)
    switch (result.shim) {
      case 'applied':
        logger.info('supabase shim applied')
        break
      case 'already_applied':
        logger.info('supabase shim already applied')
        break
      case 'skipped_managed':
      case 'missing':
        break
    }
    logger.info(
      `migrations: ${result.migrations.applied.length} applied, ${result.migrations.skipped.length} already applied`,
    )

    if (shouldSeed(options, appEnv)) {
      const seeds = await listSqlFiles(SEED_DIR)
      const applied = await runSeeds(db, seeds, readSql, logger)
      logger.info(`seeds: ${applied.length} applied`)
    }
  } finally {
    await db.end()
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof MigrationError) {
    console.error(`[db] FAILED ${error.file}`)
    console.error(error.cause instanceof Error ? error.cause.message : String(error.cause))
  } else {
    console.error('[db] FAILED', error instanceof Error ? error.message : error)
  }
  process.exitCode = 1
})
