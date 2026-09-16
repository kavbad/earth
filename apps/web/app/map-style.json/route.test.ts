import { colors } from '@earth/ui'
import { describe, expect, it } from 'vitest'

import { GET, STYLE_CACHE_CONTROL, dynamic } from './route'

describe('GET /map-style.json', () => {
  it('is a constant document, prerendered at build', () => {
    expect(dynamic).toBe('force-static')
  })

  it('serves the built-in fallback style as JSON, cacheable', async () => {
    const response = GET()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('cache-control')).toBe(STYLE_CACHE_CONTROL)

    // MapLibre's minimum: a version-8 style with a background layer and no remote sources — the
    // property that keeps a journey off the network.
    const style = (await response.json()) as {
      readonly version: number
      readonly sources: Record<string, unknown>
      readonly layers: readonly {
        readonly type: string
        readonly paint?: Record<string, unknown>
      }[]
      readonly metadata?: Record<string, unknown>
    }
    expect(style.version).toBe(8)
    expect(style.sources).toEqual({})
    expect(style.layers).toHaveLength(1)
    expect(style.layers[0]?.type).toBe('background')
    expect(style.layers[0]?.paint?.['background-color']).toBe(colors.subtleFill)
    expect(style.metadata?.['earth:fallback']).toBe(true)
  })
})
