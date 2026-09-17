/**
 * The native build configuration (docs/DEPLOYMENT.md §5): the EAS project id, the Android push
 * and maps credentials, and the EAS profiles that carry the `EXPO_PUBLIC_*` environment.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PUBLIC_ENV_KEYS, PublicEnvPrefixes, publicEnvVariableName } from '@earth/config'
import { describe, expect, it, vi } from 'vitest'

import config, {
  EAS_PROJECT_ID_REQUIRED,
  LOCAL_EAS_PROJECT_ID,
  MOBILE_BUILD_ENV,
  MOBILE_PUBLIC_ENV_VARIABLES,
  androidConfig,
  androidGoogleMapsApiKey,
  androidGoogleServicesFile,
  earthExpoConfig,
  easProjectId,
  isProductionBuild,
  missingPublicEnv,
} from './app.config'

const PROJECT_ID = '2b3f9d16-6a1a-4f4a-9c9b-1f2a3b4c5d6e'
const MAPS_KEY = 'AIza-test-android-maps-key'
const GOOGLE_SERVICES = '/var/secrets/google-services.json'

const publicEnv = Object.fromEntries(
  MOBILE_PUBLIC_ENV_VARIABLES.map((name) => [name, 'set']),
) as Record<string, string>

interface EasJson {
  readonly cli: { readonly version: string; readonly appVersionSource: string }
  readonly build: Readonly<
    Record<
      string,
      {
        readonly channel?: string
        readonly environment?: string
        readonly env?: Readonly<Record<string, string>>
      }
    >
  >
  readonly submit: Readonly<Record<string, unknown>>
}

const here = dirname(fileURLToPath(import.meta.url))
const easJson = JSON.parse(readFileSync(join(here, 'eas.json'), 'utf8')) as EasJson

describe('EAS project id', () => {
  it('comes from EAS_PROJECT_ID', () => {
    expect(easProjectId({ [MOBILE_BUILD_ENV.easProjectId]: ` ${PROJECT_ID} ` })).toBe(PROJECT_ID)
    expect(earthExpoConfig({}, { [MOBILE_BUILD_ENV.easProjectId]: PROJECT_ID }).extra).toEqual({
      eas: { projectId: PROJECT_ID },
    })
  })

  it('falls back to the local placeholder outside a production build', () => {
    expect(easProjectId({})).toBe(LOCAL_EAS_PROJECT_ID)
    expect(easProjectId({ [MOBILE_BUILD_ENV.buildProfile]: 'preview' })).toBe(LOCAL_EAS_PROJECT_ID)
    expect(easProjectId({ [MOBILE_BUILD_ENV.appEnv]: 'development' })).toBe(LOCAL_EAS_PROJECT_ID)
  })

  it('refuses a production build without it, naming what to set', () => {
    for (const env of [
      { [MOBILE_BUILD_ENV.buildProfile]: 'production' },
      { [MOBILE_BUILD_ENV.appEnv]: 'production' },
      { [MOBILE_BUILD_ENV.buildProfile]: 'production', [MOBILE_BUILD_ENV.easProjectId]: '  ' },
    ]) {
      expect(isProductionBuild(env)).toBe(true)
      expect(() => easProjectId(env)).toThrow(EAS_PROJECT_ID_REQUIRED)
      expect(() => earthExpoConfig({}, env)).toThrow(/eas init/)
    }
  })

  it('resolves a production build that has the id', () => {
    const resolved = earthExpoConfig(
      {},
      { ...publicEnv, EAS_BUILD_PROFILE: 'production', EAS_PROJECT_ID: PROJECT_ID },
    )
    expect(resolved.extra).toEqual({ eas: { projectId: PROJECT_ID } })
  })
})

describe('Android build configuration', () => {
  it('references google-services.json from GOOGLE_SERVICES_JSON when set (FCM v1 push)', () => {
    expect(androidGoogleServicesFile({ GOOGLE_SERVICES_JSON: ` ${GOOGLE_SERVICES} ` })).toBe(
      GOOGLE_SERVICES,
    )
    expect(androidConfig({ GOOGLE_SERVICES_JSON: GOOGLE_SERVICES }).googleServicesFile).toBe(
      GOOGLE_SERVICES,
    )
  })

  it('omits googleServicesFile when unset, so a local build still resolves', () => {
    expect(androidGoogleServicesFile({})).toBeUndefined()
    expect(androidConfig({})).not.toHaveProperty('googleServicesFile')
    expect(androidConfig({ GOOGLE_SERVICES_JSON: '' })).not.toHaveProperty('googleServicesFile')
  })

  it('carries the Google Maps Android key from EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY', () => {
    expect(androidGoogleMapsApiKey({ EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY: MAPS_KEY })).toBe(
      MAPS_KEY,
    )
    expect(androidConfig({ EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY: MAPS_KEY }).config).toEqual({
      googleMaps: { apiKey: MAPS_KEY },
    })
  })

  it('omits the maps key when unset and never adds one to iOS (Apple Maps)', () => {
    expect(androidConfig({})).not.toHaveProperty('config')
    const resolved = earthExpoConfig({}, { EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY: MAPS_KEY })
    expect(resolved.ios).not.toHaveProperty('config')
    expect(JSON.stringify(resolved.ios)).not.toContain(MAPS_KEY)
  })

  it('keeps the deep link intent filters and the package', () => {
    const android = androidConfig({ GOOGLE_SERVICES_JSON: GOOGLE_SERVICES })
    expect(android.package).toBe('social.earth.app')
    expect(android.intentFilters?.[0]?.data).toEqual([
      { scheme: 'https', host: 'earth.social', pathPrefix: '/g/' },
      { scheme: 'https', host: 'earth.social', pathPrefix: '/live/' },
      { scheme: 'https', host: 'earth.social', pathPrefix: '/p/' },
      { scheme: 'https', host: 'earth.social', pathPrefix: '/@' },
    ])
  })
})

describe('public environment', () => {
  it('lists exactly the EXPO_PUBLIC_ variables the schema defines', () => {
    expect(MOBILE_PUBLIC_ENV_VARIABLES).toEqual(
      PUBLIC_ENV_KEYS.map((key) => publicEnvVariableName(key, PublicEnvPrefixes.mobile)),
    )
  })

  it('reports what a build is missing and warns once in a production build', () => {
    expect(missingPublicEnv(publicEnv)).toEqual([])
    expect(missingPublicEnv({ EXPO_PUBLIC_SUPABASE_URL: 'set' })).toEqual(
      MOBILE_PUBLIC_ENV_VARIABLES.filter((name) => name !== 'EXPO_PUBLIC_SUPABASE_URL'),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      earthExpoConfig({}, { EAS_BUILD_PROFILE: 'production', EAS_PROJECT_ID: PROJECT_ID })
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0]?.[0])).toContain('EXPO_PUBLIC_SUPABASE_ANON_KEY')
      warn.mockClear()
      earthExpoConfig({}, {})
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('eas.json', () => {
  it('links an EAS environment and a channel to every build profile', () => {
    expect(Object.keys(easJson.build)).toEqual(['development', 'preview', 'production'])
    for (const [name, profile] of Object.entries(easJson.build)) {
      expect(profile.environment, `${name}.environment`).toBe(name)
      expect(profile.channel, `${name}.channel`).toBe(name)
      expect(profile.env?.['EXPO_PUBLIC_APP_ENV'], `${name}.env`).toBe(name)
    }
  })

  it('keeps the remote version source the production profile increments', () => {
    expect(easJson.cli.appVersionSource).toBe('remote')
    expect(easJson.submit['production']).toBeDefined()
  })
})

describe('default export', () => {
  it('resolves from process.env, keeping the base config', () => {
    const resolved = config({
      config: { name: 'ignored', slug: 'ignored' },
      projectRoot: here,
      staticConfigPath: null,
      packageJsonPath: join(here, 'package.json'),
    })
    expect(resolved.slug).toBe('earth')
    expect(resolved.scheme).toBe('earth')
    expect(resolved.ios?.associatedDomains).toEqual(['applinks:earth.social'])
  })
})
