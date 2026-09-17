/**
 * Stops what `global-setup.ts` started: the web app first (its pid file holds a process group),
 * then the local stack. The database is kept — `up.sh` recreates it on the next run — so a
 * failure can still be inspected with `psql`. Nothing happens under `E2E_EXTERNAL_STACK=1`.
 */
import { spawn } from 'node:child_process'

import { stopWeb } from './global-setup'
import { REPO_ROOT, usesExternalStack } from './fixtures/stack'

function stackDown(): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['scripts/local-stack/down.sh'], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: 'inherit',
    })
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
    child.on('error', () => {
      clearTimeout(timer)
      resolve()
    })
    child.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function globalTeardown(): Promise<void> {
  if (usesExternalStack()) return
  process.stdout.write('[e2e] stopping the web app and the local stack\n')
  await stopWeb()
  await stackDown()
}

export default globalTeardown
