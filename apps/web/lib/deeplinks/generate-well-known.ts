/**
 * Writes `public/.well-known/apple-app-site-association` and `assetlinks.json` from the
 * environment (`APPLE_TEAM_ID`, `IOS_BUNDLE_ID`, `ANDROID_PACKAGE_NAME`,
 * `ANDROID_SHA256_CERT_FINGERPRINTS`). Without those variables the placeholders are written.
 *
 * Run from the repository root: `pnpm exec tsx apps/web/lib/deeplinks/generate-well-known.ts`
 * (then `pnpm format` — Prettier re-wraps `assetlinks.json`; the test compares parsed JSON).
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { configFromEnv, hasPlaceholders, renderWellKnownFiles } from './well-known'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', '..', 'public', '.well-known')
mkdirSync(outDir, { recursive: true })

const files = renderWellKnownFiles(configFromEnv(process.env))
for (const [name, content] of Object.entries(files)) {
  writeFileSync(join(outDir, name), content)
  console.log(`wrote ${join(outDir, name)}${hasPlaceholders(content) ? ' (placeholders)' : ''}`)
}
