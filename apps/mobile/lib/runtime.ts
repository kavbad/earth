/**
 * The runtime every provider shares: validated public env, the Supabase client, the `@earth/auth`
 * session helper and the `EarthClient` (ARCHITECTURE §7). Built once per app process.
 */
import { type EarthClient, createEarthClient } from '@earth/api'
import { type SupabaseSession, createSupabaseSession } from '@earth/auth'
import type { PublicEnv } from '@earth/config'
import type { SupabaseClient } from '@supabase/supabase-js'

import { type PublicEnvResult, readPublicEnv } from './env'
import { createMobileSupabaseClient } from './supabase/client'

export interface MobileRuntime {
  readonly env: PublicEnv
  readonly supabase: SupabaseClient
  readonly session: SupabaseSession
  readonly earth: EarthClient
}

export type MobileRuntimeResult =
  | { readonly ok: true; readonly runtime: MobileRuntime }
  | { readonly ok: false; readonly issues: readonly string[] }

let cached: MobileRuntimeResult | undefined

export function createMobileRuntime(): MobileRuntimeResult {
  const env: PublicEnvResult = readPublicEnv()
  if (!env.ok) return { ok: false, issues: env.issues }
  const supabase = createMobileSupabaseClient({ env: env.env })
  const session = createSupabaseSession({ supabase })
  const earth = createEarthClient({
    supabase,
    serverBaseUrl: env.env.API_BASE_URL,
    fetch: (input, init) => fetch(input, init),
    getAccessToken: () => session.getAccessToken(),
  })
  return { ok: true, runtime: { env: env.env, supabase, session, earth } }
}

/** One runtime per process (React StrictMode runs initialisers twice). */
export function getMobileRuntime(): MobileRuntimeResult {
  cached ??= createMobileRuntime()
  return cached
}

/** Tests only. */
export function resetMobileRuntime(): void {
  cached = undefined
}
