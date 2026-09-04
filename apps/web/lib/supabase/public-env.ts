/**
 * The web app's public environment (`NEXT_PUBLIC_*`), validated by `@earth/config`
 * (ARCHITECTURE §14).
 *
 * Next only inlines a `process.env.NEXT_PUBLIC_*` variable into client bundles when it is
 * referenced statically, so every public key is spelled out once in `nextPublicEnvSource`. The
 * same function serves route handlers and server components, where `process.env` is live.
 * `WEB_PUBLIC_ENV_VARIABLES` is derived from the schema so a test can prove the two lists agree.
 */
import {
  type EnvSource,
  PUBLIC_ENV_KEYS,
  type PublicEnv,
  PublicEnvPrefixes,
  loadPublicEnv,
  publicEnvVariableName,
} from '@earth/config'

export const WEB_PUBLIC_ENV_PREFIX = PublicEnvPrefixes.web

/** Every `NEXT_PUBLIC_*` name the schema knows; `nextPublicEnvSource` must reference exactly these. */
export const WEB_PUBLIC_ENV_VARIABLES: readonly string[] = PUBLIC_ENV_KEYS.map((key) =>
  publicEnvVariableName(key, WEB_PUBLIC_ENV_PREFIX),
)

/** One static reference per public variable so bundlers inline them (never iterate `process.env`). */
export function nextPublicEnvSource(): EnvSource {
  return {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_API_BASE_URL: process.env.NEXT_PUBLIC_API_BASE_URL,
    NEXT_PUBLIC_LIVEKIT_URL: process.env.NEXT_PUBLIC_LIVEKIT_URL,
    NEXT_PUBLIC_POSTHOG_KEY: process.env.NEXT_PUBLIC_POSTHOG_KEY,
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_MAP_STYLE_URL: process.env.NEXT_PUBLIC_MAP_STYLE_URL,
    NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
    NEXT_PUBLIC_WEB_ORIGIN: process.env.NEXT_PUBLIC_WEB_ORIGIN,
  }
}

/**
 * Validates the web public environment.
 *
 * @throws {EnvError} (from `@earth/config`) listing every missing or invalid variable.
 */
export function loadWebPublicEnv(source: EnvSource = nextPublicEnvSource()): PublicEnv {
  return loadPublicEnv(source, WEB_PUBLIC_ENV_PREFIX)
}
