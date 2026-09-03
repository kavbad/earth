import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  PLACEHOLDER_CONFIG,
  UNIVERSAL_LINK_PATHS,
  appleAppSiteAssociation,
  assetLinks,
  configFromEnv,
  hasPlaceholders,
  renderWellKnownFiles,
} from './well-known'

const here = dirname(fileURLToPath(import.meta.url))
const publicDir = join(here, '..', '..', 'public', '.well-known')

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

  it('match the committed public files (placeholders until deploy; Prettier may re-wrap them)', () => {
    const files = renderWellKnownFiles(PLACEHOLDER_CONFIG)
    const read = (name: string): unknown => JSON.parse(readFileSync(join(publicDir, name), 'utf8'))
    expect(read('apple-app-site-association')).toEqual(
      JSON.parse(files['apple-app-site-association']),
    )
    expect(read('assetlinks.json')).toEqual(JSON.parse(files['assetlinks.json']))
  })
})
