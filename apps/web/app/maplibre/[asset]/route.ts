/**
 * `GET /maplibre/:asset` — MapLibre's worker files, served by the app from the installed package
 * (see `lib/map/worker.ts` for why). Prerendered at build for the two names, so the files ship
 * with the app at exactly the bundled library's version; anything else is a 404.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import {
  MAPLIBRE_WORKER_ASSETS,
  type MapLibreWorkerAsset,
  isMapLibreWorkerAsset,
} from '../../../lib/map/worker'

export const dynamic = 'force-static'
export const dynamicParams = false

export const WORKER_CACHE_CONTROL = 'public, max-age=86400'

export function generateStaticParams(): { asset: MapLibreWorkerAsset }[] {
  return MAPLIBRE_WORKER_ASSETS.map((asset) => ({ asset }))
}

/**
 * The installed package's `dist`, found by walking up from the working directory (the bundler
 * rewrites `require.resolve` into its own module ids, so it cannot be asked). pnpm hoists the
 * package to the workspace root; a plain install keeps it beside the app.
 */
function distDir(): string {
  let dir = process.cwd()
  for (;;) {
    const candidate = path.join(dir, 'node_modules', 'maplibre-gl', 'dist')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error('maplibre-gl is not installed')
    dir = parent
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ asset: string }> },
): Promise<Response> {
  const { asset } = await context.params
  if (!isMapLibreWorkerAsset(asset)) return new Response(null, { status: 404 })
  const body = await readFile(path.join(distDir(), asset), 'utf8')
  return new Response(body, {
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': WORKER_CACHE_CONTROL,
    },
  })
}
