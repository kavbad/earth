/**
 * `GET /map-style.json` — the map's basemap, served by the app itself.
 *
 * SCREEN 20 takes its basemap from `NEXT_PUBLIC_MAP_STYLE_URL`. Pointed here, the map depends on
 * nothing outside this origin: Earth's land as silhouettes from data that ships with the app
 * (`lib/map/basemap.ts`), fading into the plain surface at city zoom. The journeys build the app
 * this way (`e2e/global-setup.ts`) so a run reaches nothing outside the machine — a third-party
 * tile host that stalled from the CI runner's network once failed E2E 10 and looked like a
 * product defect. Development keeps whichever basemap `.local/stack.env` names.
 */
import { basemapStyle } from '../../lib/map/basemap'

/** A constant document: prerendered at build, never computed per request. */
export const dynamic = 'force-static'

export const STYLE_CACHE_CONTROL = 'public, max-age=86400'

export function GET(): Response {
  return Response.json(basemapStyle(), { headers: { 'cache-control': STYLE_CACHE_CONTROL } })
}
