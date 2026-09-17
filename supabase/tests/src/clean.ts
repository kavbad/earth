/** Drops every harness database (all runs) — `pnpm db:test:clean` after a crashed run. */
import { adminUrlFromEnv, cleanupAllTestDatabases } from './template'

const dropped = await cleanupAllTestDatabases(adminUrlFromEnv())
console.log(
  `[db-tests] dropped ${dropped.length} database(s)${dropped.length ? `: ${dropped.join(', ')}` : ''}`,
)
