/**
 * Builds the migrated template database once per vitest run and hands its coordinates to the test
 * workers (harness.ts reads them with `inject`). Teardown drops the template and any scratch
 * database a test file left behind.
 */
import { config as loadDotenv } from 'dotenv'
import path from 'node:path'
import type { TestProject } from 'vitest/node'

import { REPO_ROOT } from '../../../scripts/db/migrate-lib'
import {
  PROVIDED_ADMIN_URL,
  PROVIDED_TEMPLATE,
  TEMPLATE_DATABASE,
  adminUrlFromEnv,
  buildTemplate,
  destroyTemplate,
} from './template'

let adminUrl: string | undefined

export async function setup(project: TestProject): Promise<void> {
  loadDotenv({ path: path.join(REPO_ROOT, '.env'), quiet: true })
  adminUrl = adminUrlFromEnv()
  const started = Date.now()
  const result = await buildTemplate(adminUrl, {
    info: (message) => console.log(`[db-tests] ${message}`),
  })
  console.log(
    `[db-tests] template ${TEMPLATE_DATABASE} ready (shim ${result.shim}, ` +
      `${result.migrations.applied.length} migrations) in ${Date.now() - started}ms`,
  )
  project.provide(PROVIDED_ADMIN_URL, adminUrl)
  project.provide(PROVIDED_TEMPLATE, TEMPLATE_DATABASE)
}

export async function teardown(): Promise<void> {
  if (adminUrl === undefined) return
  await destroyTemplate(adminUrl)
}
