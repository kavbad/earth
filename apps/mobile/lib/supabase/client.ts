/**
 * The supabase-js client of the app: anon key, the session persisted in the secure store, no URL
 * session detection (the OTP code is typed, never a redirect). Public env only — RLS governs
 * access (ARCHITECTURE §4, §14). Screens never call `supabase.rpc`; the client is handed to
 * `createEarthClient` from `@earth/api` (ARCHITECTURE §7) and, structurally, to `@earth/realtime`.
 */
import type { PublicEnv } from '@earth/config'
import { type SupabaseClient, createClient } from '@supabase/supabase-js'

import type { AsyncKeyValueStorage } from './chunkedStorage'
import { createSecureSessionStorage } from './secureStorage'

export type SupabaseConnectionEnv = Pick<PublicEnv, 'SUPABASE_URL' | 'SUPABASE_ANON_KEY'>

export interface CreateSupabaseClientOptions {
  readonly env: SupabaseConnectionEnv
  /** Defaults to the chunked secure store. */
  readonly storage?: AsyncKeyValueStorage | undefined
}

export function createMobileSupabaseClient(options: CreateSupabaseClientOptions): SupabaseClient {
  return createClient(options.env.SUPABASE_URL, options.env.SUPABASE_ANON_KEY, {
    auth: {
      storage: options.storage ?? createSecureSessionStorage(),
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  })
}
