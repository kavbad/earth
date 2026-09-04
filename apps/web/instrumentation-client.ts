/**
 * Browser error monitoring (spec §14; docs/DEPLOYMENT.md §8). Next runs this file after the
 * document loads and before hydration, which is early enough to catch a failing first render.
 *
 * `NEXT_PUBLIC_SENTRY_DSN` is the switch: unset (the local and open-source default) means no
 * Sentry client is created and nothing is sent. The DSN, the app environment and the commit are
 * the only `NEXT_PUBLIC_*` values read here, and each is referenced statically so Next inlines it.
 *
 * The release name is `buildRelease` of `@earth/observability` — the same helper and the same
 * `earth-web@<version>[+<commit>]` string the server tier builds in `lib/server/env.ts`, so a
 * browser event and the server event it caused land on one release. `sendDefaultPii` stays off:
 * error reports carry no IP, cookie or request body (spec §14).
 */
import { RELEASE_COMMIT_PATTERN, buildRelease } from '@earth/observability'
import * as Sentry from '@sentry/nextjs'

import packageJson from './package.json'

/** Must equal `WEB_APP_NAME` in `lib/server/env.ts` (asserted by the test). */
export const BROWSER_RELEASE_APP = 'earth-web' as const
export const BROWSER_APP_VERSION: string = packageJson.version

/** Vercel's automatic public commit variable; absent locally and in other hosts. */
export const BROWSER_COMMIT_VARIABLE = 'NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA' as const
export const BROWSER_DSN_VARIABLE = 'NEXT_PUBLIC_SENTRY_DSN' as const
export const BROWSER_APP_ENV_VARIABLE = 'NEXT_PUBLIC_APP_ENV' as const

export const DEFAULT_BROWSER_APP_ENV = 'development' as const

export interface BrowserSentryOptions {
  readonly dsn: string
  readonly environment: string
  readonly release: string
  /** Never attach IPs, cookies or bodies to an event (spec §14: no PII in error reports). */
  readonly sendDefaultPii: false
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim()
  return result === undefined || result === '' ? undefined : result
}

/** `earth-web@<version>[+<commit>]`; the commit is dropped when it is not a commit sha. */
export function browserRelease(commit: string | undefined): string {
  const sha = trimmed(commit)?.toLowerCase()
  return buildRelease(
    sha !== undefined && RELEASE_COMMIT_PATTERN.test(sha)
      ? { app: BROWSER_RELEASE_APP, version: BROWSER_APP_VERSION, commit: sha }
      : { app: BROWSER_RELEASE_APP, version: BROWSER_APP_VERSION },
  )
}

/** The `Sentry.init` options for this build, or `null` when no DSN is configured. */
export function browserSentryOptions(
  source: Readonly<Record<string, string | undefined>>,
): BrowserSentryOptions | null {
  const dsn = trimmed(source[BROWSER_DSN_VARIABLE])
  if (dsn === undefined) return null
  return {
    dsn,
    environment: trimmed(source[BROWSER_APP_ENV_VARIABLE]) ?? DEFAULT_BROWSER_APP_ENV,
    release: browserRelease(source[BROWSER_COMMIT_VARIABLE]),
    sendDefaultPii: false,
  }
}

/** `Sentry.init`, structurally — the test passes a recorder instead of the real namespace. */
export interface BrowserSentryLike {
  init(options: BrowserSentryOptions): unknown
}

/** Initialises the browser client when a DSN is set; returns what it did (tests, and honesty). */
export function initBrowserMonitoring(
  sentry: BrowserSentryLike,
  source: Readonly<Record<string, string | undefined>>,
): BrowserSentryOptions | null {
  const options = browserSentryOptions(source)
  if (options === null) return null
  try {
    sentry.init(options)
  } catch {
    // Monitoring must never be the reason a page fails to start.
    return null
  }
  return options
}

initBrowserMonitoring(Sentry, {
  [BROWSER_DSN_VARIABLE]: process.env.NEXT_PUBLIC_SENTRY_DSN,
  [BROWSER_APP_ENV_VARIABLE]: process.env.NEXT_PUBLIC_APP_ENV,
  [BROWSER_COMMIT_VARIABLE]: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
})
