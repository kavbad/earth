import { describe, expect, it } from 'vitest'

import {
  SCOPE_ZOOM,
  WORLD_VIEW,
  boundsAround,
  boundsKey,
  clampBounds,
  fallbackStyle,
  roundBounds,
  viewForScope,
} from './view'

describe('viewForScope', () => {
  const city = { lat: 37.77, lng: -122.42 }

  it('starts World zoomed out even when a city is known', () => {
    expect(viewForScope('world', city)).toEqual(WORLD_VIEW)
  })

  it('centres Friends / Neighborhood / City on the city at their zoom', () => {
    expect(viewForScope('neighborhood', city)).toEqual({
      center: city,
      zoom: SCOPE_ZOOM.neighborhood,
    })
    expect(viewForScope('city', city)).toEqual({ center: city, zoom: SCOPE_ZOOM.city })
    expect(viewForScope('friends', city).zoom).toBe(SCOPE_ZOOM.friends)
  })

  it('falls back to the world view without a city', () => {
    expect(viewForScope('city', null)).toEqual(WORLD_VIEW)
  })
})

describe('bounds', () => {
  it('rounds to three decimals and keeps the tuple ordered', () => {
    expect(roundBounds([-122.42011, 37.7599, -122.41, 37.7701])).toEqual([
      -122.42, 37.76, -122.41, 37.77,
    ])
    expect(roundBounds([1, 1, 0, 0])).toEqual([0, 0, 1, 1])
  })

  it('clamps an over-wide world box to the globe', () => {
    expect(clampBounds([-400, -95, 400, 95])).toEqual([-180, -90, 180, 90])
  })

  it('keys equal within jitter', () => {
    expect(boundsKey([-122.4201, 37.7601, -122.4101, 37.7701])).toBe(
      boundsKey([-122.4203, 37.7603, -122.4103, 37.7703]),
    )
  })

  it('builds a box around points and none around nothing', () => {
    expect(boundsAround([])).toBeNull()
    const box = boundsAround([{ lat: 1, lng: 2 }], 0.5)
    expect(box).toEqual([1.5, 0.5, 2.5, 1.5])
  })
})

describe('fallbackStyle', () => {
  it('is a light background-only style', () => {
    const style = fallbackStyle({ background: '#FFFFFF', subtleFill: '#F6F7F8' })
    expect(style['version']).toBe(8)
    expect(style['sources']).toEqual({})
    expect(JSON.stringify(style)).toContain('#F6F7F8')
  })
})
