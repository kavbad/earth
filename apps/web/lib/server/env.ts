/**
 * Environment of the mounted server tier (ARCHITECTURE §14): the validated `ServerEnv` and
 * `PublicEnv` of `@earth/config` plus the few platform variables that are not part of those
 * schemas — Vercel's `CRON_SECRET` and `VERCEL_GIT_COMMIT_SHA`, and `LOG_LEVEL`.
 *
 * Both schemas are loaded so an operator sees every problem at once; the server tier needs the
 * public block too (`SUPABASE_URL` / `SUPABASE_ANON_KEY` for the anon and per-user clients).
 */
import {
  EnvError,
  type EnvIssue,
  type EnvSource,
  type PublicEnv,
  type ServerEnv,
  loadServerEnv,
} from '@earth/config'
import {
  type LogLevel,
  RELEASE_COMMIT_PATTERN,
  buildRelease,
  parseLogLevel,
} from '@earth/observability'

import packageJson from '../../package.json'
import { loadWebPublicEnv } from '../supabase/public-env'

export const WEB_APP_NAME = 'earth-web' as const
export const WEB_APP_VERSION: string = packageJson.version

/**
 * Vercel sets `Authorization: Bearer <CRON_SECRET>` on the requests its scheduler makes when this
 * variable is set (it sends no custom headers). `/api/internal/*` accepts it in addition to
 * `x-earth-cron-secret: <INTERNAL_CRON_SECRET>` (see `./cron.ts`).
 */
export const VERCEL_CRON_SECRET_VARIABLE = 'CRON_SECRET' as const
/** Set by Vercel builds; used for the Sentry release name when present. */
export const VERCEL_COMMIT_VARIABLE = 'VERCEL_GIT_COMMIT_SHA' as const
/** `debug | info | warn | error`; defaults to `info`. */
export const LOG_LEVEL_VARIABLE = 'LOG_LEVEL' as const

export interface WebServerEnv {
  readonly server: ServerEnv
  readonly public: PublicEnv
  /** `CRON_SECRET` when set; `undefined` means only `x-earth-cron-secret` authenticates crons. */
  readonly vercelCronSecret: string | undefined
  readonly logLevel: LogLevel
  /** `earth-web@<version>[+<commit>]` — shared by Sentry, the logger base fields and health. */
  readonly release: string
}

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const result = value.trim()
  return result === '' ? undefined : result
}

/** The Sentry release name for this build (`buildRelease` in `@earth/observability`). */
export function releaseFor(source: EnvSource): string {
  const commit = trimmed(source[VERCEL_COMMIT_VARIABLE])
  return buildRelease(
    commit !== undefined && RELEASE_COMMIT_PATTERN.test(commit)
      ? { app: WEB_APP_NAME, version: WEB_APP_VERSION, commit }
      : { app: WEB_APP_NAME, version: WEB_APP_VERSION },
  )
}

/**
 * Validates everything the mounted server tier needs.
 *
 * @throws {EnvError} listing the server and public issues together.
 */
export function loadWebServerEnv(source: EnvSource): WebServerEnv {
  const issues: EnvIssue[] = []
  let server: ServerEnv | undefined
  let publicEnv: PublicEnv | undefined
  try {
    server = loadServerEnv(source)
  } catch (cause) {
    if (!(cause instanceof EnvError)) throw cause
    issues.push(...cause.issues)
  }
  try {
    publicEnv = loadWebPublicEnv(source)
  } catch (cause) {
    if (!(cause instanceof EnvError)) throw cause
    issues.push(...cause.issues)
  }
  if (server === undefined || publicEnv === undefined) throw new EnvError('server', issues)
  return {
    server,
    public: publicEnv,
    vercelCronSecret: trimmed(source[VERCEL_CRON_SECRET_VARIABLE]),
    logLevel: parseLogLevel(source[LOG_LEVEL_VARIABLE]),
    release: releaseFor(source),
  }
}
