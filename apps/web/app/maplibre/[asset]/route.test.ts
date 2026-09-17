import { describe, expect, it } from 'vitest'

import { MAPLIBRE_WORKER_ASSETS, MAPLIBRE_WORKER_URL } from '../../../lib/map/worker'
import { GET, WORKER_CACHE_CONTROL, dynamic, dynamicParams, generateStaticParams } from './route'

const request = new Request('http://localhost/maplibre/x')
const params = (asset: string) => ({ params: Promise.resolve({ asset }) })

describe('GET /maplibre/:asset', () => {
  it('prerenders exactly the two worker files', () => {
    expect(dynamic).toBe('force-static')
    expect(dynamicParams).toBe(false)
    expect(generateStaticParams()).toEqual(MAPLIBRE_WORKER_ASSETS.map((asset) => ({ asset })))
    expect(MAPLIBRE_WORKER_URL).toBe('/maplibre/maplibre-gl-worker.mjs')
  })

  it("serves the installed library's worker and its shared chunk as JavaScript", async () => {
    for (const asset of MAPLIBRE_WORKER_ASSETS) {
      const response = await GET(request, params(asset))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
      expect(response.headers.get('cache-control')).toBe(WORKER_CACHE_CONTROL)
      const body = await response.text()
      expect(body).toContain('MapLibre GL JS')
      expect(body.length).toBeGreaterThan(1_000)
    }
    // The worker imports its shared chunk by the sibling name the route serves it under.
    const worker = await (await GET(request, params(MAPLIBRE_WORKER_ASSETS[0]))).text()
    expect(worker).toContain('./maplibre-gl-shared.mjs')
  })

  it('answers 404 for anything else', async () => {
    expect((await GET(request, params('maplibre-gl.mjs'))).status).toBe(404)
    expect((await GET(request, params('../package.json'))).status).toBe(404)
  })
})
