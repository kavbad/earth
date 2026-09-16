import type { AreaId } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import {
  SCOPE_ZOOM,
  WORLD_VIEW,
  boundsAround,
  boundsKey,
  cameraAreaId,
  clampBounds,
  fallbackStyle,
  roundBounds,
  viewForScope,
} from './view'

describe('viewForScope', () => {
  const city = { lat: 37.77, lng: -122.42 }

  it("starts World zoomed out, turned to the city's longitude when one is known", () => {
    expect(viewForScope('world', city)).toEqual({
      center: { lat: WORLD_VIEW.center.lat, lng: city.lng },
      zoom: WORLD_VIEW.zoom,
    })
    expect(viewForScope('world', null)).toEqual(WORLD_VIEW)
  })

  it('centres Friends / Neighborhood / City on their area at their zoom', () => {
    expect(viewForScope('neighborhood', city)).toEqual({
      center: city,
      zoom: SCOPE_ZOOM.neighborhood,
    })
    expect(viewForScope('city', city)).toEqual({ center: city, zoom: SCOPE_ZOOM.city })
    expect(viewForScope('friends', city).zoom).toBe(SCOPE_ZOOM.friends)
  })

  it('falls back to the world view without an area', () => {
    expect(viewForScope('city', null)).toEqual(WORLD_VIEW)
  })
})

describe('cameraAreaId', () => {
  const MISSION = 'a0000000-0000-4000-8000-000000000001' as AreaId
  const SF = 'a0000000-0000-4000-8000-000000000002' as AreaId
  const NYC = 'a0000000-0000-4000-8000-000000000003' as AreaId
  const context = { currentAreaId: MISSION, currentCityId: SF, homeCityId: NYC }

  it('starts Neighborhood from the current neighborhood and the other radii from the city', () => {
    expect(cameraAreaId('neighborhood', context)).toBe(MISSION)
    expect(cameraAreaId('friends', context)).toBe(SF)
    expect(cameraAreaId('city', context)).toBe(SF)
    expect(cameraAreaId('world', context)).toBe(SF)
  })

  it('starts Neighborhood from the city when no neighborhood is known', () => {
    expect(cameraAreaId('neighborhood', { ...context, currentAreaId: null })).toBe(SF)
  })

  it('falls back to the home city, where "Your Earth" always starts', () => {
    expect(cameraAreaId('city', { ...context, currentCityId: null })).toBe(NYC)
    expect(cameraAreaId('neighborhood', context, true)).toBe(NYC)
    expect(cameraAreaId('friends', { ...context, homeCityId: null }, true)).toBe(SF)
  })

  it('has nowhere to start from without a context', () => {
    expect(cameraAreaId('neighborhood', null)).toBeNull()
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
