/**
 * The browser runtime every provider shares: validated public env, the memoised Supabase
 * browser client, the `@earth/auth` session helper and the `EarthClient` (ARCHITECTURE §7).
 * Built once per tab on the client; server renders get the stub of `./stub.ts`.
 */
import { type EarthClient, createEarthClient } from '@earth/api'
import { type SupabaseSession, createSupabaseSession } from '@earth/auth'
import type { PublicEnv } from '@earth/config'
import type { SupabaseClient } from '@supabase/supabase-js'

import { type PublicEnvResult, readPublicEnv } from '../env'
import { getSupabaseBrowserClient } from '../supabase/client'

export interface WebRuntime {
  readonly env: PublicEnv
  readonly supabase: SupabaseClient
  readonly session: SupabaseSession
  readonly earth: EarthClient
}

export type WebRuntimeResult =
  | { readonly ok: true; readonly runtime: WebRuntime }
  | { readonly ok: false; readonly issues: readonly string[] }

let cached: WebRuntimeResult | undefined

export function createWebRuntime(): WebRuntimeResult {
  const env: PublicEnvResult = readPublicEnv()
  if (!env.ok) return { ok: false, issues: env.issues }
  const supabase = getSupabaseBrowserClient()
  const session = createSupabaseSession({ supabase })
  const earth = createEarthClient({
    supabase,
    serverBaseUrl: env.env.API_BASE_URL,
    fetch: (input, init) => fetch(input, init),
    getAccessToken: () => session.getAccessToken(),
  })
  return { ok: true, runtime: { env: env.env, supabase, session, earth } }
}

/** One runtime per tab (React StrictMode runs initialisers twice). */
export function getWebRuntime(): WebRuntimeResult {
  cached ??= createWebRuntime()
  return cached
}

/** Tests only. */
export function resetWebRuntime(): void {
  cached = undefined
}
