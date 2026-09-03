/**
 * Where the journeys point and how they wait for the stack (ARCHITECTURE.md §15).
 *
 * Every value has three sources, in order: an explicit export in `process.env`, the dotenv the
 * local stack writes (`.local/stack.env`, produced by `scripts/local-stack/up.sh`), then the
 * documented default. `global-setup.ts` loads the same file into `process.env` before the workers
 * fork, so specs and setup always agree.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url))
export const E2E_DIR = path.resolve(FIXTURES_DIR, '..')
export const REPO_ROOT = path.resolve(E2E_DIR, '..')

export const LOCAL_DIR = path.join(REPO_ROOT, '.local')
export const LOG_DIR = path.join(LOCAL_DIR, 'logs')
export const PID_DIR = path.join(LOCAL_DIR, 'pids')
/** Build + server output of the web app this harness starts. */
export const WEB_LOG_FILE = path.join(LOG_DIR, 'e2e-web.log')
/** Process group of that server, so the teardown (and `down.sh`) can stop it. */
export const WEB_PID_FILE = path.join(PID_DIR, 'e2e-web.pid')
export const STACK_ENV_FILE = path.join(LOCAL_DIR, 'stack.env')

export const DEFAULT_BASE_URL = 'http://localhost:3000'
export const DEFAULT_GATEWAY_URL = 'http://localhost:54321'
export const DEFAULT_MAILPIT_URL = 'http://127.0.0.1:8025'

/** `lib/server/health.ts`: 200 + `{ ok, service, serverTier }`, 503 while the env is invalid. */
export const HEALTH_PATH = '/api/health'
/** GoTrue behind the Supabase-shaped gateway (`scripts/local-stack/gateway.mjs`). */
export const GATEWAY_HEALTH_PATH = '/auth/v1/health'

/** Minimal dotenv: `KEY=VALUE` lines, `#` comments and blank lines, optional matching quotes. */
export function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1)
    }
    values[key] = value
  }
  return values
}

/** `.local/stack.env` as an object; empty when the stack has never been started. */
export function readStackEnv(file: string = STACK_ENV_FILE): Record<string, string> {
  return existsSync(file) ? parseDotenv(readFileSync(file, 'utf8')) : {}
}

/** `process.env` wins over the stack's dotenv, which wins over the default. */
export function stackValue(key: string, fallback: string): string {
  const exported = process.env[key]
  if (exported !== undefined && exported !== '') return exported
  const value = readStackEnv()[key]
  return value === undefined || value === '' ? fallback : value
}

export function baseURL(): string {
  return stackValue('E2E_BASE_URL', DEFAULT_BASE_URL).replace(/\/+$/, '')
}

/** The one Supabase-shaped origin: `/rest/v1` → PostgREST, `/auth/v1` → GoTrue. */
export function gatewayURL(): string {
  return stackValue('NEXT_PUBLIC_SUPABASE_URL', DEFAULT_GATEWAY_URL).replace(/\/+$/, '')
}

export function mailpitURL(): string {
  return stackValue('EARTH_MAILPIT_URL', DEFAULT_MAILPIT_URL).replace(/\/+$/, '')
}

/** Anon key minted from the dev JWT secret; needed for direct GoTrue calls (sign-in helpers). */
export function anonKey(): string {
  return stackValue('NEXT_PUBLIC_SUPABASE_ANON_KEY', '')
}

/** `E2E_EXTERNAL_STACK=1`: the stack and the web app are already running; do not touch them. */
export function usesExternalStack(): boolean {
  return process.env['E2E_EXTERNAL_STACK'] === '1'
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

export interface WaitForHttpOptions {
  readonly timeoutMs?: number
  readonly intervalMs?: number
  /** Defaults to "answered 200". */
  readonly accept?: (response: Response) => Promise<boolean> | boolean
}

/**
 * Polls a URL until it is healthy. Never sleeps blindly: the caller decides what healthy means,
 * and the failure message names the last status so a broken stack is obvious in the report.
 */
export async function waitForHttp(
  label: string,
  url: string,
  options: WaitForHttpOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const intervalMs = options.intervalMs ?? 500
  const accept = options.accept ?? ((response: Response) => response.status === 200)
  const deadline = Date.now() + timeoutMs
  let last = 'no answer'
  for (;;) {
    try {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      if (await accept(response)) return
      last = `status ${response.status}`
    } catch (cause) {
      last = cause instanceof Error ? cause.message : String(cause)
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label} was not ready at ${url} within ${timeoutMs / 1000}s (${last})`)
    }
    await sleep(intervalMs)
  }
}

/** The web app answers `/api/health` with a ready server tier. */
export async function waitForWeb(timeoutMs = 120_000): Promise<void> {
  await waitForHttp('the web app', `${baseURL()}${HEALTH_PATH}`, {
    timeoutMs,
    accept: async (response) => {
      if (response.status !== 200) return false
      const body = (await response.json()) as { ok?: unknown; serverTier?: unknown }
      return body.ok === true && body.serverTier === 'ready'
    },
  })
}

/** The gateway answers for GoTrue. */
export async function waitForGateway(timeoutMs = 60_000): Promise<void> {
  await waitForHttp('the local stack gateway', `${gatewayURL()}${GATEWAY_HEALTH_PATH}`, {
    timeoutMs,
  })
}
