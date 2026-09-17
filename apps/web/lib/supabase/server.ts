/**
 * Server-side Supabase client for server components, server functions and route handlers that
 * render as the signed-in person (`@supabase/ssr`'s `createServerClient` over Next's cookie
 * store). A new client is created per request — never shared across requests.
 *
 * Server components may read cookies but cannot set them, so `setAll` swallows that failure:
 * token refreshes are then written by a route handler or proxy that owns the response.
 * The service-role client of the server tier lives in `../server/deps.ts`, never here.
 */
import type { PublicEnv } from '@earth/config'
import { type CookieOptions, createServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'

import { loadWebPublicEnv } from './public-env'

export interface CookiePair {
  readonly name: string
  readonly value: string
}

export interface CookieToSet extends CookiePair {
  readonly options: CookieOptions
}

/** The slice of Next's `await cookies()` store the client needs (a fake in tests). */
export interface CookieStoreLike {
  getAll(): readonly CookiePair[]
  /** Absent or throwing outside a route handler / server function; both are tolerated. */
  set?(name: string, value: string, options: CookieOptions): unknown
}

export interface ServerClientCookieMethods {
  getAll(): CookiePair[]
  setAll(cookiesToSet: readonly CookieToSet[]): void
}

/** `createServerClient` of `@supabase/ssr`, structurally (tests inject a fake). */
export type ServerSupabaseClientFactory = (
  url: string,
  anonKey: string,
  options: { readonly cookies: ServerClientCookieMethods },
) => SupabaseClient

export type SupabaseConnectionEnv = Pick<PublicEnv, 'SUPABASE_URL' | 'SUPABASE_ANON_KEY'>

export interface CreateServerSupabaseClientOptions {
  readonly env?: SupabaseConnectionEnv | undefined
  readonly factory?: ServerSupabaseClientFactory | undefined
}

/** Cookie methods over any store; setting failures (server components) are ignored on purpose. */
export function cookieMethodsFor(store: CookieStoreLike): ServerClientCookieMethods {
  return {
    getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
    setAll: (cookiesToSet) => {
      if (store.set === undefined) return
      try {
        for (const { name, value, options } of cookiesToSet) store.set(name, value, options)
      } catch {
        // Server components cannot set cookies; a route handler or proxy refreshes the session.
      }
    },
  }
}

export function createSupabaseServerClientFromCookies(
  store: CookieStoreLike,
  options: CreateServerSupabaseClientOptions = {},
): SupabaseClient {
  const env = options.env ?? loadWebPublicEnv()
  const factory: ServerSupabaseClientFactory = options.factory ?? createServerClient
  return factory(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { cookies: cookieMethodsFor(store) })
}

/** The per-request client for server components and route handlers (reads Next's cookie store). */
export async function createSupabaseServerClient(): Promise<SupabaseClient> {
  return createSupabaseServerClientFromCookies(await cookies())
}
