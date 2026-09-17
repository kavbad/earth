/**
 * The app's public environment (`EXPO_PUBLIC_*`), validated by `@earth/config` (ARCHITECTURE
 * §14). Metro only inlines a `process.env.EXPO_PUBLIC_*` variable when it is referenced
 * statically, so every public key is spelled out once in `expoPublicEnvSource`. Read once and
 * never at module load; a misconfigured build is reported as a value, not thrown from a render.
 */
import {
  EnvError,
  type EnvSource,
  PUBLIC_ENV_KEYS,
  type PublicEnv,
  PublicEnvPrefixes,
  loadPublicEnv,
  publicEnvVariableName,
} from '@earth/config'

export const MOBILE_PUBLIC_ENV_PREFIX = PublicEnvPrefixes.mobile

/** Every `EXPO_PUBLIC_*` name the schema knows; `expoPublicEnvSource` must reference exactly these. */
export const MOBILE_PUBLIC_ENV_VARIABLES: readonly string[] = PUBLIC_ENV_KEYS.map((key) =>
  publicEnvVariableName(key, MOBILE_PUBLIC_ENV_PREFIX),
)

/** One static reference per public variable so Metro inlines them (never iterate `process.env`). */
export function expoPublicEnvSource(): EnvSource {
  return {
    EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
    EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
    EXPO_PUBLIC_API_BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL,
    EXPO_PUBLIC_LIVEKIT_URL: process.env.EXPO_PUBLIC_LIVEKIT_URL,
    EXPO_PUBLIC_POSTHOG_KEY: process.env.EXPO_PUBLIC_POSTHOG_KEY,
    EXPO_PUBLIC_POSTHOG_HOST: process.env.EXPO_PUBLIC_POSTHOG_HOST,
    EXPO_PUBLIC_SENTRY_DSN: process.env.EXPO_PUBLIC_SENTRY_DSN,
    EXPO_PUBLIC_MAP_STYLE_URL: process.env.EXPO_PUBLIC_MAP_STYLE_URL,
    EXPO_PUBLIC_APP_ENV: process.env.EXPO_PUBLIC_APP_ENV,
    EXPO_PUBLIC_WEB_ORIGIN: process.env.EXPO_PUBLIC_WEB_ORIGIN,
  }
}

/**
 * Validates the mobile public environment.
 *
 * @throws {EnvError} (from `@earth/config`) listing every missing or invalid variable.
 */
export function loadMobilePublicEnv(source: EnvSource = expoPublicEnvSource()): PublicEnv {
  return loadPublicEnv(source, MOBILE_PUBLIC_ENV_PREFIX)
}

export type PublicEnvResult =
  | { readonly ok: true; readonly env: PublicEnv }
  | { readonly ok: false; readonly issues: readonly string[] }

/** The environment as a value: `ok` with the env, or the list of problems to show once. */
export function validatePublicEnv(source: EnvSource = expoPublicEnvSource()): PublicEnvResult {
  try {
    return { ok: true, env: loadMobilePublicEnv(source) }
  } catch (error) {
    const issues =
      error instanceof EnvError
        ? error.issues.map((issue) => `${issue.variable}: ${issue.message}`)
        : [error instanceof Error ? error.message : String(error)]
    return { ok: false, issues }
  }
}

let cached: PublicEnvResult | undefined

export function readPublicEnv(): PublicEnvResult {
  cached ??= validatePublicEnv()
  return cached
}

/** Tests only. */
export function resetPublicEnvCache(): void {
  cached = undefined
}

export function isDevelopmentEnv(env: PublicEnv): boolean {
  return env.APP_ENV === 'development'
}
