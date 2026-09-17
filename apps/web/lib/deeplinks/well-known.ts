/**
 * Universal / App Links association documents (spec §112): `/.well-known/apple-app-site-association`
 * and `/.well-known/assetlinks.json`. Both are served from the environment by the route handlers
 * under `app/.well-known/` (`APPLE_TEAM_ID`, `IOS_BUNDLE_ID`, `ANDROID_PACKAGE_NAME`,
 * `ANDROID_SHA256_CERT_FINGERPRINTS`); with none of them set the documents render with the
 * placeholders below, which is the honest local default — no app can claim these links yet.
 * The path list is the deep link contract itself, derived from `DEEP_LINK_PATHS`.
 */
import { DEEP_LINK_PATHS } from '@earth/domain'

export const APPLE_TEAM_ID_PLACEHOLDER = 'APPLE_TEAM_ID' as const
export const ANDROID_FINGERPRINT_PLACEHOLDER =
  'ANDROID_SHA256_CERT_FINGERPRINT_00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00' as const

export const DEFAULT_IOS_BUNDLE_ID = 'social.earth.app' as const
export const DEFAULT_ANDROID_PACKAGE = 'social.earth.app' as const

/** Environment variables the generator reads (deploy-time, never shipped to clients). */
export const WELL_KNOWN_ENV = {
  appleTeamId: 'APPLE_TEAM_ID',
  iosBundleId: 'IOS_BUNDLE_ID',
  androidPackage: 'ANDROID_PACKAGE_NAME',
  /** Comma-separated SHA-256 signing certificate fingerprints. */
  androidFingerprints: 'ANDROID_SHA256_CERT_FINGERPRINTS',
} as const

/** Path patterns the native apps claim (spec §112), in the association file's syntax. */
export const UNIVERSAL_LINK_PATHS: readonly string[] = [
  `${DEEP_LINK_PATHS.groupInvite}*`,
  `${DEEP_LINK_PATHS.roomInvite}*`,
  `${DEEP_LINK_PATHS.profile}*`,
  `${DEEP_LINK_PATHS.post}*`,
]

export interface WellKnownConfig {
  readonly appleTeamId: string
  readonly iosBundleId: string
  readonly androidPackage: string
  readonly androidFingerprints: readonly string[]
}

export const PLACEHOLDER_CONFIG: WellKnownConfig = {
  appleTeamId: APPLE_TEAM_ID_PLACEHOLDER,
  iosBundleId: DEFAULT_IOS_BUNDLE_ID,
  androidPackage: DEFAULT_ANDROID_PACKAGE,
  androidFingerprints: [ANDROID_FINGERPRINT_PLACEHOLDER],
}

export function configFromEnv(env: Readonly<Record<string, string | undefined>>): WellKnownConfig {
  const fingerprints = (env[WELL_KNOWN_ENV.androidFingerprints] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  return {
    appleTeamId: env[WELL_KNOWN_ENV.appleTeamId]?.trim() || PLACEHOLDER_CONFIG.appleTeamId,
    iosBundleId: env[WELL_KNOWN_ENV.iosBundleId]?.trim() || PLACEHOLDER_CONFIG.iosBundleId,
    androidPackage: env[WELL_KNOWN_ENV.androidPackage]?.trim() || PLACEHOLDER_CONFIG.androidPackage,
    androidFingerprints:
      fingerprints.length > 0 ? fingerprints : PLACEHOLDER_CONFIG.androidFingerprints,
  }
}

/** `apple-app-site-association` (no extension, served as JSON). */
export function appleAppSiteAssociation(config: WellKnownConfig): Record<string, unknown> {
  const appId = `${config.appleTeamId}.${config.iosBundleId}`
  return {
    applinks: {
      details: [
        {
          appIDs: [appId],
          components: UNIVERSAL_LINK_PATHS.map((path) => ({ '/': path })),
        },
      ],
    },
    webcredentials: { apps: [appId] },
  }
}

/** `assetlinks.json` for Android App Links. */
export function assetLinks(config: WellKnownConfig): readonly Record<string, unknown>[] {
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: config.androidPackage,
        sha256_cert_fingerprints: [...config.androidFingerprints],
      },
    },
  ]
}

export function renderWellKnownFiles(config: WellKnownConfig): {
  readonly 'apple-app-site-association': string
  readonly 'assetlinks.json': string
} {
  return {
    'apple-app-site-association': `${JSON.stringify(appleAppSiteAssociation(config), null, 2)}\n`,
    'assetlinks.json': `${JSON.stringify(assetLinks(config), null, 2)}\n`,
  }
}

/** True while a rendered document still carries a placeholder (a production deploy must not). */
export function hasPlaceholders(rendered: string): boolean {
  return (
    rendered.includes(APPLE_TEAM_ID_PLACEHOLDER) ||
    rendered.includes('ANDROID_SHA256_CERT_FINGERPRINT_')
  )
}

export type WellKnownDocumentName = keyof ReturnType<typeof renderWellKnownFiles>

/** Apple reads the extensionless association file only when it is served as JSON (spec §112). */
export const WELL_KNOWN_CONTENT_TYPE = 'application/json' as const
/**
 * Association documents change only with a deploy, but they must never be cached so long that a
 * fingerprint rotation cannot be undone; Apple and Google both re-fetch on their own schedule.
 */
export const WELL_KNOWN_CACHE_CONTROL = 'public, max-age=300, must-revalidate' as const

/** The response the `/.well-known/<name>` route handler returns, rendered from `env`. */
export function wellKnownResponse(
  name: WellKnownDocumentName,
  env: Readonly<Record<string, string | undefined>>,
): Response {
  return new Response(renderWellKnownFiles(configFromEnv(env))[name], {
    headers: {
      'content-type': WELL_KNOWN_CONTENT_TYPE,
      'cache-control': WELL_KNOWN_CACHE_CONTROL,
    },
  })
}
