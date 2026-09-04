/**
 * Helpers for the tests that hold repository files (`.env.example`, `turbo.json`,
 * `supabase/config.toml`) to the schemas. Not part of the package API (not re-exported).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Repository root (`packages/config/src` → three levels up). */
const REPO_ROOT_URL = new URL('../../../', import.meta.url)

export function repoPath(relative: string): string {
  return fileURLToPath(new URL(relative, REPO_ROOT_URL))
}

export function readRepoFile(relative: string): string {
  return readFileSync(repoPath(relative), 'utf8')
}

/** Variables in `.env.example` read by tooling outside `@earth/config` (scripts/db, e2e, turbo). */
export const TOOLING_ENV_KEYS = ['DATABASE_URL', 'E2E_BASE_URL'] as const

/**
 * Deploy-time variables documented in `.env.example` that neither schema validates: they are read
 * while a client is *built* or a document is *served*, or they are set by the hosting platform —
 * never by `loadPublicEnv` / `loadServerEnv`. `EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY` carries the
 * public prefix because Expo inlines it into the Android manifest through
 * `apps/mobile/app.config.ts`, not because app code reads it.
 */
export const DEPLOY_ENV_KEYS = [
  // Universal / App Links association documents (spec §112) — apps/web/app/.well-known.
  'APPLE_TEAM_ID',
  'IOS_BUNDLE_ID',
  'ANDROID_PACKAGE_NAME',
  'ANDROID_SHA256_CERT_FINGERPRINTS',
  // EAS build inputs — apps/mobile/app.config.ts.
  'EAS_PROJECT_ID',
  'GOOGLE_SERVICES_JSON',
  'EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY',
  // Vercel's own cron credential — apps/web/lib/server/{env,cron}.ts.
  'CRON_SECRET',
] as const

/** `KEY=value` lines; comments and blanks skipped. Intentionally simpler than dotenv (no quoting). */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) throw new Error(`dotenv: malformed line "${raw}"`)
    const key = line.slice(0, eq).trim()
    if (key in out) throw new Error(`dotenv: duplicate key ${key}`)
    out[key] = line.slice(eq + 1).trim()
  }
  return out
}

/** Minimal TOML lookup: the first `key = value` inside `[section]` (strings unquoted). */
export function tomlValue(toml: string, section: string, key: string): string {
  let inSection = false
  for (const line of toml.split('\n')) {
    const header = /^\[([^\]]+)\]/.exec(line)
    if (header) {
      inSection = header[1] === section
      continue
    }
    if (!inSection) continue
    const pair = new RegExp(`^${key}\\s*=\\s*(.+?)\\s*(#.*)?$`).exec(line)
    if (pair?.[1] !== undefined) return pair[1].replace(/^"|"$/g, '')
  }
  throw new Error(`[${section}] ${key} not found`)
}
