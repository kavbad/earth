/**
 * The journeys own the stack for a run (ARCHITECTURE.md §15): `scripts/local-stack/up.sh`
 * recreates `earth_local` from the migrations and the seeds and starts Postgres, PostgREST,
 * GoTrue, LiveKit, Mailpit and the gateway; then this builds `apps/web` with that environment and
 * starts it on 3000 with the mock Human-verification provider. Everything the web app prints —
 * build and server — goes to `.local/logs/e2e-web.log`.
 *
 * `KEEP_DB` is deliberately unset: every journey creates the people it needs, and the seeded
 * fixtures must be exactly what `supabase/seed` says they are.
 *
 * With `E2E_EXTERNAL_STACK=1` nothing is started or stopped; the run only waits for the stack and
 * the web app to answer (that is how CI, and a developer with `pnpm stack:up:web`, run it).
 */
import { type ChildProcess, spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'

import {
  LOG_DIR,
  PID_DIR,
  REPO_ROOT,
  WEB_LOG_FILE,
  WEB_PID_FILE,
  baseURL,
  readStackEnv,
  sleep,
  stackValue,
  usesExternalStack,
  waitForGateway,
  waitForWeb,
} from './fixtures/stack'

const STACK_UP_TIMEOUT_MS = 300_000
const BUILD_TIMEOUT_MS = 900_000

function log(message: string): void {
  process.stdout.write(`[e2e] ${message}\n`)
}

/** Runs a command to completion; rejects with the tail of `logFile` when it fails. */
function run(
  label: string,
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs: number; logFile?: string },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = options.logFile === undefined ? undefined : openSync(options.logFile, 'a')
    const child = spawn(command, [...args], {
      cwd: REPO_ROOT,
      env: options.env ?? process.env,
      stdio: out === undefined ? 'inherit' : ['ignore', out, out],
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${label} did not finish within ${options.timeoutMs / 1000}s`))
    }, options.timeoutMs)
    const done = (): void => {
      clearTimeout(timer)
      if (out !== undefined) closeSync(out)
    }
    child.on('error', (cause) => {
      done()
      reject(cause)
    })
    child.on('exit', (code, signal) => {
      done()
      if (code === 0) {
        resolve()
        return
      }
      const tail =
        options.logFile === undefined || !existsSync(options.logFile)
          ? ''
          : `\n${readFileSync(options.logFile, 'utf8').split('\n').slice(-40).join('\n')}`
      reject(new Error(`${label} exited with ${signal ?? code}${tail}`))
    })
  })
}

/** Environment for the web app: the stack's dotenv, the mock provider, development behaviour. */
function webEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...readStackEnv() }
  env['HUMAN_VERIFICATION_PROVIDER'] = 'mock'
  env['APP_ENV'] = 'development'
  env['NEXT_TELEMETRY_DISABLED'] = '1'
  delete env['KEEP_DB']
  return env
}

/** Stops a web server left behind by an interrupted run (its pid file is a process group). */
export async function stopWeb(): Promise<void> {
  if (!existsSync(WEB_PID_FILE)) return
  const pid = Number.parseInt(readFileSync(WEB_PID_FILE, 'utf8').trim(), 10)
  rmSync(WEB_PID_FILE, { force: true })
  if (!Number.isInteger(pid) || pid <= 0) return
  const alive = (): boolean => {
    try {
      process.kill(-pid, 0)
      return true
    } catch {
      return false
    }
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    return
  }
  const deadline = Date.now() + 10_000
  while (alive() && Date.now() < deadline) await sleep(100)
  if (alive()) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

function startWeb(): ChildProcess {
  const port = stackValue('EARTH_PORT_WEB', '3000')
  const out = openSync(WEB_LOG_FILE, 'a')
  const child = spawn('pnpm', ['--filter', 'earth-web', 'start', '--port', port], {
    cwd: REPO_ROOT,
    env: webEnv(),
    // Its own process group, so the whole tree (pnpm + next) can be stopped at once — the same
    // shape `scripts/local-stack/down.sh` expects, which is why the pid file lives beside its own.
    detached: true,
    stdio: ['ignore', out, out],
  })
  child.unref()
  writeFileSync(WEB_PID_FILE, `${child.pid ?? ''}\n`)
  return child
}

async function globalSetup(): Promise<void> {
  mkdirSync(LOG_DIR, { recursive: true })
  mkdirSync(PID_DIR, { recursive: true })

  if (usesExternalStack()) {
    log('E2E_EXTERNAL_STACK=1 — using the stack and web app that are already running')
    await waitForGateway()
    await waitForWeb()
    log(`ready at ${baseURL()}`)
    return
  }

  await stopWeb()
  writeFileSync(WEB_LOG_FILE, `# ${new Date().toISOString()} e2e web app (build + server)\n`)

  try {
    log('starting the local stack (scripts/local-stack/up.sh)')
    const stackEnv: NodeJS.ProcessEnv = { ...process.env, APP_ENV: 'development' }
    delete stackEnv['KEEP_DB']
    await run('scripts/local-stack/up.sh', 'bash', ['scripts/local-stack/up.sh'], {
      env: stackEnv,
      timeoutMs: STACK_UP_TIMEOUT_MS,
    })
    await waitForGateway()

    // The stack's dotenv is what the workers will read (they fork after this function).
    Object.assign(process.env, readStackEnv())
    process.env['HUMAN_VERIFICATION_PROVIDER'] = 'mock'
    process.env['APP_ENV'] = 'development'

    log(`building apps/web → ${WEB_LOG_FILE}`)
    await run('pnpm --filter earth-web build', 'pnpm', ['--filter', 'earth-web', 'build'], {
      env: webEnv(),
      timeoutMs: BUILD_TIMEOUT_MS,
      logFile: WEB_LOG_FILE,
    })

    log(`starting apps/web on ${baseURL()}`)
    startWeb()
    await waitForWeb()
    log('ready')
  } catch (cause) {
    // globalTeardown does not run when setup fails: leave nothing behind.
    await stopWeb()
    await run('scripts/local-stack/down.sh', 'bash', ['scripts/local-stack/down.sh'], {
      timeoutMs: 60_000,
    }).catch(() => undefined)
    throw cause
  }
}

export default globalSetup
