/**
 * Expo app config (ARCHITECTURE.md §14; docs/DEPLOYMENT.md §5). Everything a *build* needs that
 * is not fixed identity comes from the environment, so no credential and no project id is
 * committed:
 *
 * - `EAS_PROJECT_ID` — `extra.eas.projectId`. Locally it falls back to {@link LOCAL_EAS_PROJECT_ID}
 *   so `expo start` / `expo export` / `expo config` work with no EAS account; a production build
 *   refuses to resolve without it (there is no correct guess, and the wrong one uploads to
 *   someone else's project).
 * - `GOOGLE_SERVICES_JSON` — path to the Firebase file FCM v1 push needs on Android (spec §12).
 * - `EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY` — `react-native-maps` renders through Google Maps on
 *   Android; without the key that map is blank. iOS stays on Apple Maps (`PROVIDER_DEFAULT`) and
 *   needs no key.
 *
 * The `EXPO_PUBLIC_*` values the app itself reads ({@link MOBILE_PUBLIC_ENV_VARIABLES}) are
 * supplied by the EAS environment linked to each profile in `eas.json`; they are not repeated
 * here. This module imports nothing but types: Expo evaluates it with a plain TypeScript
 * transform, so it must stand on its own.
 */
import type { ConfigContext, ExpoConfig } from 'expo/config'

/** Canonical web origin; deep links under it open in the app (ARCHITECTURE.md §14). */
const WEB_HOST = 'earth.social'
const BUNDLE_ID = 'social.earth.app'
const DEEP_LINK_PATH_PREFIXES = ['/g/', '/live/', '/p/', '/@'] as const

/** Environment read while the native config is resolved (build inputs, never app values). */
export const MOBILE_BUILD_ENV = {
  easProjectId: 'EAS_PROJECT_ID',
  googleServicesFile: 'GOOGLE_SERVICES_JSON',
  googleMapsAndroidKey: 'EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY',
  /** Set by EAS to the `eas.json` build profile being built. */
  buildProfile: 'EAS_BUILD_PROFILE',
  appEnv: 'EXPO_PUBLIC_APP_ENV',
} as const

/**
 * Every `EXPO_PUBLIC_*` variable the client reads through `@earth/config` (`loadPublicEnv`). A
 * build that omits them ships a client that cannot reach Supabase, so each `eas.json` profile
 * links an EAS environment that defines them; `app.config.test.ts` holds this list to the schema.
 */
export const MOBILE_PUBLIC_ENV_VARIABLES = [
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  'EXPO_PUBLIC_API_BASE_URL',
  'EXPO_PUBLIC_LIVEKIT_URL',
  'EXPO_PUBLIC_POSTHOG_KEY',
  'EXPO_PUBLIC_POSTHOG_HOST',
  'EXPO_PUBLIC_SENTRY_DSN',
  'EXPO_PUBLIC_MAP_STYLE_URL',
  'EXPO_PUBLIC_APP_ENV',
  'EXPO_PUBLIC_WEB_ORIGIN',
] as const

/** Stands in for the real project id outside a production build (never uploads anywhere). */
export const LOCAL_EAS_PROJECT_ID = '00000000-0000-0000-0000-000000000000' as const

export const EAS_PROJECT_ID_REQUIRED =
  'EAS_PROJECT_ID is required for a production build: run `eas init` in apps/mobile, then set ' +
  'EAS_PROJECT_ID (EAS environment variable, and in whatever runs `eas build`). ' +
  'See docs/DEPLOYMENT.md §5.1.'

export const PRODUCTION_PROFILE = 'production' as const

export type BuildEnvSource = Readonly<Record<string, string | undefined>>

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim()
  return result === undefined || result === '' ? undefined : result
}

/** A build that ships: the `production` EAS profile, or an explicitly production app env. */
export function isProductionBuild(env: BuildEnvSource): boolean {
  return (
    trimmed(env[MOBILE_BUILD_ENV.buildProfile]) === PRODUCTION_PROFILE ||
    trimmed(env[MOBILE_BUILD_ENV.appEnv]) === PRODUCTION_PROFILE
  )
}

/**
 * `extra.eas.projectId`.
 *
 * @throws {Error} in a production build with no `EAS_PROJECT_ID`.
 */
export function easProjectId(env: BuildEnvSource): string {
  const configured = trimmed(env[MOBILE_BUILD_ENV.easProjectId])
  if (configured !== undefined) return configured
  if (isProductionBuild(env)) throw new Error(EAS_PROJECT_ID_REQUIRED)
  return LOCAL_EAS_PROJECT_ID
}

/** `android.googleServicesFile` when a path is configured (FCM v1 push, spec §12). */
export function androidGoogleServicesFile(env: BuildEnvSource): string | undefined {
  return trimmed(env[MOBILE_BUILD_ENV.googleServicesFile])
}

/** `android.config.googleMaps.apiKey` when a key is configured (react-native-maps on Android). */
export function androidGoogleMapsApiKey(env: BuildEnvSource): string | undefined {
  return trimmed(env[MOBILE_BUILD_ENV.googleMapsAndroidKey])
}

/** `EXPO_PUBLIC_*` variables the app reads that this build does not have (empty is the goal). */
export function missingPublicEnv(env: BuildEnvSource): readonly string[] {
  return MOBILE_PUBLIC_ENV_VARIABLES.filter((name) => trimmed(env[name]) === undefined)
}

export function androidConfig(env: BuildEnvSource): NonNullable<ExpoConfig['android']> {
  const googleServicesFile = androidGoogleServicesFile(env)
  const googleMapsApiKey = androidGoogleMapsApiKey(env)
  return {
    package: BUNDLE_ID,
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#ffffff',
    },
    ...(googleServicesFile === undefined ? {} : { googleServicesFile }),
    ...(googleMapsApiKey === undefined
      ? {}
      : { config: { googleMaps: { apiKey: googleMapsApiKey } } }),
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        data: DEEP_LINK_PATH_PREFIXES.map((pathPrefix) => ({
          scheme: 'https',
          host: WEB_HOST,
          pathPrefix,
        })),
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
  }
}

/** Exported for tests; the default export reads `process.env`. */
export function earthExpoConfig(base: Partial<ExpoConfig>, env: BuildEnvSource): ExpoConfig {
  const projectId = easProjectId(env)
  const missing = missingPublicEnv(env)
  if (missing.length > 0 && isProductionBuild(env)) {
    // Not fatal: EAS resolves the config more than once, and only the build itself must have them.
    console.warn(`app.config: production build without ${missing.join(', ')}`)
  }
  return {
    ...base,
    name: 'Earth',
    slug: 'earth',
    version: '0.1.0',
    orientation: 'portrait',
    scheme: 'earth',
    userInterfaceStyle: 'light',
    icon: './assets/icon.png',
    backgroundColor: '#ffffff',
    ios: {
      bundleIdentifier: BUNDLE_ID,
      supportsTablet: false,
      associatedDomains: [`applinks:${WEB_HOST}`],
      infoPlist: {
        UIBackgroundModes: ['audio', 'voip'],
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: androidConfig(env),
    plugins: [
      'expo-router',
      'expo-secure-store',
      [
        'expo-splash-screen',
        {
          image: './assets/splash.png',
          imageWidth: 200,
          resizeMode: 'contain',
          backgroundColor: '#ffffff',
        },
      ],
      [
        'expo-camera',
        {
          cameraPermission: 'Earth uses the camera so you can go Live and post photos.',
          microphonePermission: 'Earth uses the microphone so people can hear you in rooms.',
          recordAudioAndroid: true,
        },
      ],
      [
        'expo-location',
        {
          locationWhenInUsePermission:
            'Earth uses your location to show what is happening around you and to share it with people you choose.',
        },
      ],
      [
        'expo-notifications',
        {
          // Android: a push lands on `messages` unless the server names `live` or `social`;
          // the app creates all three channels before it registers a token (lib/push.ts).
          defaultChannel: 'messages',
        },
      ],
      [
        'expo-image-picker',
        {
          photosPermission: 'Earth uses your photos so you can post and set your picture.',
          cameraPermission: 'Earth uses the camera so you can take a photo to post.',
        },
      ],
      '@livekit/react-native-expo-plugin',
      [
        'expo-build-properties',
        {
          android: {
            minSdkVersion: 24,
          },
        },
      ],
    ],
    experiments: {
      typedRoutes: false,
    },
    extra: {
      eas: {
        projectId,
      },
    },
  }
}

const config = ({ config: base }: ConfigContext): ExpoConfig => earthExpoConfig(base, process.env)

export default config
