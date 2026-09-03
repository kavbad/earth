import { defineConfig, devices } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_BASE_URL = 'http://localhost:3000'
export const HEALTH_PATH = '/api/health'

const baseURL = process.env.E2E_BASE_URL ?? DEFAULT_BASE_URL

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Where the self-started web server's environment comes from (first existing file wins): the dotenv
 * the local stack writes (`pnpm stack:up`, ARCHITECTURE.md §15), else the developer's `.env`
 * (copied from `.env.example`). `next dev` only reads `apps/web/.env*`, and `/api/health` answers
 * 503 until the server tier's environment validates (`lib/server/health.ts`) — without this,
 * Playwright never sees the standalone server become ready.
 */
export const WEB_SERVER_ENV_FILES = ['.local/stack.env', '.env'] as const

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

/**
 * Variables for the web server Playwright starts itself: the first existing env file's values,
 * minus anything already exported in `processEnv` (an explicit export always wins; Playwright
 * layers `webServer.env` over `process.env`).
 */
export function webServerEnv(
  processEnv: NodeJS.ProcessEnv,
  files: readonly string[] = WEB_SERVER_ENV_FILES,
  root: string = REPO_ROOT,
): Record<string, string> {
  const file = files.map((name) => path.join(root, name)).find((candidate) => existsSync(candidate))
  if (file === undefined) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parseDotenv(readFileSync(file, 'utf8')))) {
    if (processEnv[key] === undefined) out[key] = value
  }
  return out
}

// Chromium fake media devices let journeys exercise camera/mic flows headlessly
// (ARCHITECTURE.md §15). Chromium itself comes from PLAYWRIGHT_BROWSERS_PATH; never run
// `playwright install` here.
const FAKE_MEDIA_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']

export default defineConfig({
  testDir: './journeys',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    permissions: ['camera', 'microphone'],
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { args: FAKE_MEDIA_ARGS },
      },
    },
  ],
  // When no stack provides E2E_BASE_URL, start the web app so journeys can run standalone, with
  // the server tier's environment from .local/stack.env or .env (see WEB_SERVER_ENV_FILES).
  // With the local stack up (scripts/local-stack) the running server is reused.
  ...(process.env.E2E_BASE_URL
    ? {}
    : {
        webServer: {
          command: 'pnpm --filter earth-web dev',
          url: `${DEFAULT_BASE_URL}${HEALTH_PATH}`,
          reuseExistingServer: true,
          timeout: 180_000,
          env: webServerEnv(process.env),
        },
      }),
})
