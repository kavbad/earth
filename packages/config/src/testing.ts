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
