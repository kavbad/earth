import { afterEach, describe, expect, it, vi } from 'vitest'

import { GET as appleRoute } from '../../app/.well-known/apple-app-site-association/route'
import { GET as androidRoute } from '../../app/.well-known/assetlinks.json/route'
import {
  PLACEHOLDER_CONFIG,
  UNIVERSAL_LINK_PATHS,
  WELL_KNOWN_CONTENT_TYPE,
  appleAppSiteAssociation,
  assetLinks,
  configFromEnv,
  hasPlaceholders,
  renderWellKnownFiles,
  wellKnownResponse,
} from './well-known'

const CONFIGURED = {
  APPLE_TEAM_ID: 'ABCDE12345',
  IOS_BUNDLE_ID: 'social.earth.ios',
  ANDROID_PACKAGE_NAME: 'social.earth.droid',
  ANDROID_SHA256_CERT_FINGERPRINTS: 'AA:BB:CC, DD:EE:FF',
} as const

describe('universal link paths', () => {
  it('cover exactly the spec §112 links', () => {
    expect(UNIVERSAL_LINK_PATHS).toEqual(['/g/*', '/live/*', '/@*', '/p/*'])
  })
})

describe('configFromEnv', () => {
  it('reads the deploy variables and splits fingerprints', () => {
    const config = configFromEnv({
      APPLE_TEAM_ID: 'ABCDE12345',
      IOS_BUNDLE_ID: 'social.earth.ios',
      ANDROID_PACKAGE_NAME: 'social.earth.android',
      ANDROID_SHA256_CERT_FINGERPRINTS: 'AA:BB, CC:DD',
    })
    expect(config).toEqual({
      appleTeamId: 'ABCDE12345',
      iosBundleId: 'social.earth.ios',
      androidPackage: 'social.earth.android',
      androidFingerprints: ['AA:BB', 'CC:DD'],
    })
  })

  it('falls back to placeholders when unset', () => {
    expect(configFromEnv({})).toEqual(PLACEHOLDER_CONFIG)
  })
})

describe('documents', () => {
  it('build the Apple association with the team id and every path', () => {
    const doc = appleAppSiteAssociation({ ...PLACEHOLDER_CONFIG, appleTeamId: 'TEAM' })
    expect(doc).toMatchObject({
      applinks: { details: [{ appIDs: ['TEAM.social.earth.app'] }] },
      webcredentials: { apps: ['TEAM.social.earth.app'] },
    })
    const details = (doc as { applinks: { details: Array<{ components: unknown[] }> } }).applinks
      .details[0]
    expect(details?.components).toEqual(UNIVERSAL_LINK_PATHS.map((path) => ({ '/': path })))
  })

  it('build assetlinks with the package and fingerprints', () => {
    expect(assetLinks({ ...PLACEHOLDER_CONFIG, androidFingerprints: ['AA'] })).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'social.earth.app',
          sha256_cert_fingerprints: ['AA'],
        },
      },
    ])
  })

  it('flag placeholders so a production deploy can refuse them', () => {
    const files = renderWellKnownFiles(PLACEHOLDER_CONFIG)
    expect(hasPlaceholders(files['apple-app-site-association'])).toBe(true)
    expect(hasPlaceholders(files['assetlinks.json'])).toBe(true)
    const real = renderWellKnownFiles({
      appleTeamId: 'TEAM',
      iosBundleId: 'a.b',
      androidPackage: 'a.b',
      androidFingerprints: ['AA'],
    })
    expect(hasPlaceholders(real['apple-app-site-association'])).toBe(false)
  })
})

describe('wellKnownResponse', () => {
  it('serves both documents as application/json', async () => {
    for (const name of ['apple-app-site-association', 'assetlinks.json'] as const) {
      const response = wellKnownResponse(name, CONFIGURED)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe(WELL_KNOWN_CONTENT_TYPE)
      await expect(
        response.text().then((text) => JSON.parse(text) as unknown),
      ).resolves.toBeTruthy()
    }
  })
})

describe('/.well-known route handlers', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('serve the configured ids, not the placeholders', async () => {
    for (const [name, value] of Object.entries(CONFIGURED)) vi.stubEnv(name, value)

    const apple = appleRoute()
    expect(apple.headers.get('content-type')).toBe(WELL_KNOWN_CONTENT_TYPE)
    const appleBody = await apple.text()
    expect(hasPlaceholders(appleBody)).toBe(false)
    expect(JSON.parse(appleBody)).toEqual({
      applinks: {
        details: [
          {
            appIDs: ['ABCDE12345.social.earth.ios'],
            components: UNIVERSAL_LINK_PATHS.map((path) => ({ '/': path })),
          },
        ],
      },
      webcredentials: { apps: ['ABCDE12345.social.earth.ios'] },
    })

    const android = androidRoute()
    expect(android.headers.get('content-type')).toBe(WELL_KNOWN_CONTENT_TYPE)
    const androidBody = await android.text()
    expect(hasPlaceholders(androidBody)).toBe(false)
    expect(JSON.parse(androidBody)).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'social.earth.droid',
          sha256_cert_fingerprints: ['AA:BB:CC', 'DD:EE:FF'],
        },
      },
    ])
  })

  it('fall back to the placeholders when nothing is configured (local default)', async () => {
    for (const name of Object.keys(CONFIGURED)) vi.stubEnv(name, '')

    const apple = await appleRoute().text()
    const android = await androidRoute().text()
    expect(hasPlaceholders(apple)).toBe(true)
    expect(hasPlaceholders(android)).toBe(true)
    const placeholders = renderWellKnownFiles(PLACEHOLDER_CONFIG)
    expect(JSON.parse(apple)).toEqual(JSON.parse(placeholders['apple-app-site-association']))
    expect(JSON.parse(android)).toEqual(JSON.parse(placeholders['assetlinks.json']))
  })
})
