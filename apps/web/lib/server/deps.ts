/**
 * The one server-tier context of this process (ARCHITECTURE §6): `ServerDeps` built from
 * `process.env` through `@earth/config`, with the real SDKs — `@supabase/supabase-js` clients
 * (service role, anon, per-user with the caller's bearer), `expo-server-sdk` for push (with
 * `EXPO_ACCESS_TOKEN` when set), the verification provider from the `@earth/auth` registry, the
 * structured logger, and Sentry (`@sentry/nextjs`, injected into `@earth/observability`'s
 * adapter) when `SENTRY_DSN` is set — a no-op monitor otherwise.
 *
 * Creation is lazy and memoised: importing this module reads nothing, so `next build` can collect
 * route modules without an environment, and the first request pays the setup once.
 */
import * as Sentry from '@sentry/nextjs'
import { createClient } from '@supabase/supabase-js'
import type { EnvSource } from '@earth/config'
import type { ServerDeps } from '@earth/server'
import { Expo } from 'expo-server-sdk'

import { expoClientFrom, sentrySdkFrom, supabaseClientFrom } from './adapters'
import {
  type WebServerContext,
  type WebServerWiringOptions,
  createWebServerContext,
} from './wiring'

/** The production wiring: real SDKs over `source` (defaults to `process.env`). */
export function productionWiringOptions(source: EnvSource = process.env): WebServerWiringOptions {
  return {
    source,
    createSupabaseClient: (url, key, options) =>
      supabaseClientFrom(createClient(url, key, options)),
    createExpoClient: (accessToken) => expoClientFrom(new Expo({ accessToken })),
    sentry: sentrySdkFrom(Sentry),
  }
}

let context: WebServerContext | undefined

/**
 * The memoised context. A failure (invalid environment) is not cached, so a fixed environment on
 * the next request recovers without a restart.
 */
export function getServerContext(): WebServerContext {
  context ??= createWebServerContext(productionWiringOptions())
  return context
}

export function getServerDeps(): ServerDeps {
  return getServerContext().deps
}

/** Drops the memoised context (tests, and hot reload in development). */
export function resetServerContext(): void {
  context = undefined
}
