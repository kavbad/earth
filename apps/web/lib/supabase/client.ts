/**
 * Browser Supabase client (`@supabase/ssr`'s `createBrowserClient`): the session is kept in
 * cookies so server renders can read it. Public env only — the anon key is safe to ship and RLS
 * governs access (ARCHITECTURE §4, §14). Clients never call `supabase.rpc` directly; they hand
 * this client to `createEarthClient` from `@earth/api` (ARCHITECTURE §7).
 */
import type { PublicEnv } from '@earth/config'
import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

import { loadWebPublicEnv } from './public-env'

/** `createBrowserClient` of `@supabase/ssr`, structurally (tests inject a fake). */
export type BrowserSupabaseClientFactory = (url: string, anonKey: string) => SupabaseClient

export type SupabaseConnectionEnv = Pick<PublicEnv, 'SUPABASE_URL' | 'SUPABASE_ANON_KEY'>

export interface CreateBrowserSupabaseClientOptions {
  /** Defaults to the validated `NEXT_PUBLIC_*` environment. */
  readonly env?: SupabaseConnectionEnv | undefined
  readonly factory?: BrowserSupabaseClientFactory | undefined
}

export function createSupabaseBrowserClient(
  options: CreateBrowserSupabaseClientOptions = {},
): SupabaseClient {
  const env = options.env ?? loadWebPublicEnv()
  const factory: BrowserSupabaseClientFactory = options.factory ?? createBrowserClient
  return factory(env.SUPABASE_URL, env.SUPABASE_ANON_KEY)
}

let browserClient: SupabaseClient | undefined

/** One client per tab; created on first use so importing this module never reads the environment. */
export function getSupabaseBrowserClient(): SupabaseClient {
  browserClient ??= createSupabaseBrowserClient()
  return browserClient
}

/** Drops the memoised client (tests). */
export function resetSupabaseBrowserClient(): void {
  browserClient = undefined
}
