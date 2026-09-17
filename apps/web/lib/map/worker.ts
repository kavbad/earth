/**
 * Where the map's web worker lives. MapLibre resolves its worker file relative to its own
 * `import.meta.url`; inside a Next chunk that points into `/_next/static/chunks/`, where the
 * file does not exist, and a worker that fails to load leaves every data layer unrendered while
 * the background still paints — a map that looks like a plain surface. So the app serves the two
 * worker files itself (`app/maplibre/[asset]/route.ts`, from the installed package, at build)
 * and tells MapLibre to load the worker from here. Shared by the route and `maplibre.ts` so the
 * two can never disagree.
 */
export const MAPLIBRE_ASSET_PATH = '/maplibre'

/** The module worker and the chunk it imports as `./maplibre-gl-shared.mjs`, by that name. */
export const MAPLIBRE_WORKER_ASSETS = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'] as const
export type MapLibreWorkerAsset = (typeof MAPLIBRE_WORKER_ASSETS)[number]

export const MAPLIBRE_WORKER_URL = `${MAPLIBRE_ASSET_PATH}/${MAPLIBRE_WORKER_ASSETS[0]}`

export function isMapLibreWorkerAsset(name: string): name is MapLibreWorkerAsset {
  return (MAPLIBRE_WORKER_ASSETS as readonly string[]).includes(name)
}
