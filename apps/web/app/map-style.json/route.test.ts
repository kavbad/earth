import { colors } from '@earth/ui'
import { describe, expect, it } from 'vitest'

import { GET, STYLE_CACHE_CONTROL, dynamic } from './route'

describe('GET /map-style.json', () => {
  it('is a constant document, prerendered at build', () => {
    expect(dynamic).toBe('force-static')
  })

  it('serves the basemap as JSON, cacheable, with nothing to fetch', async () => {
    const response = GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('cache-control')).toBe(STYLE_CACHE_CONTROL)

    // MapLibre's minimum: a version-8 style whose sources are inline — the property that keeps a
    // journey off the network.
    const text = await response.text()
    const style = JSON.parse(text) as {
      readonly version: number
      readonly sources: Record<string, { readonly type: string; readonly data?: unknown }>
      readonly layers: readonly { readonly id: string; readonly type: string }[]
      readonly metadata?: Record<string, unknown>
    }
    expect(style.version).toBe(8)
    expect(Object.keys(style.sources)).toEqual(['land', 'graticule'])
    for (const source of Object.values(style.sources)) {
      expect(source.type).toBe('geojson')
      expect(typeof source.data).toBe('object')
    }
    expect(text).not.toMatch(/https?:\/\/|"tiles"|"url"/)
    expect(style.layers.map((layer) => layer.id)).toEqual([
      'background',
      'land',
      'coast',
      'graticule',
    ])
    expect(style.metadata?.['earth:basemap']).toBe('land-110m')
    expect(style.metadata?.['earth:surface']).toBe(colors.background)
  })
})
