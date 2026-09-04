/**
 * The validated public environment for client components, read once and never at module load
 * (so importing this file during `next build` prerendering needs no variables). A misconfigured
 * deployment is reported as a value, not thrown from a render.
 */
import { EnvError, type PublicEnv } from '@earth/config'

import { loadWebPublicEnv } from './supabase/public-env'

export type PublicEnvResult =
  | { readonly ok: true; readonly env: PublicEnv }
  | { readonly ok: false; readonly issues: readonly string[] }

let cached: PublicEnvResult | undefined

export function readPublicEnv(): PublicEnvResult {
  if (cached !== undefined) return cached
  try {
    cached = { ok: true, env: loadWebPublicEnv() }
  } catch (error) {
    const issues =
      error instanceof EnvError
        ? error.issues.map((issue) => `${issue.variable}: ${issue.message}`)
        : [error instanceof Error ? error.message : String(error)]
    cached = { ok: false, issues }
  }
  return cached
}

/** Tests only. */
export function resetPublicEnvCache(): void {
  cached = undefined
}

export function isDevelopmentEnv(env: PublicEnv): boolean {
  return env.APP_ENV === 'development'
}
