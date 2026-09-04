import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ASPECT,
  SCOPE_ZOOM,
  WORLD_VIEW,
  boundsAround,
  boundsForRegion,
  boundsKey,
  clampBounds,
  lightMapStyle,
  moveStateForRegion,
  regionForView,
  roundBounds,
  viewForScope,
  zoomForRegion,
} from './view'

const CITY = { lat: 37.7749, lng: -122.4194 }

describe('camera decisions (SCREEN 20)', () => {
  it('starts each radius from the city and World from the globe', () => {
    expect(viewForScope('world', CITY)).toEqual(WORLD_VIEW)
    expect(viewForScope('neighborhood', CITY)).toEqual({
      center: CITY,
      zoom: SCOPE_ZOOM.neighborhood,
    })
    expect(viewForScope('city', null)).toEqual(WORLD_VIEW)
  })

  it('rounds and orders bounds into a stable key', () => {
    expect(roundBounds([-122.42011, 37.76049, -122.41001, 37.77001])).toEqual([
      -122.42, 37.76, -122.41, 37.77,
    ])
    expect(roundBounds([1, 2, 0, 1])).toEqual([0, 1, 1, 2])
    expect(clampBounds([-200, -95, 200, 95])).toEqual([-180, -90, 180, 90])
    expect(boundsKey([-122.42011, 37.76049, -122.41001, 37.77001])).toBe(
      '-122.42,37.76,-122.41,37.77',
    )
  })

  it('boxes positions with padding and none for an empty list', () => {
    expect(boundsAround([])).toBeNull()
    const box = boundsAround([CITY], 0.01)
    expect(box).toEqual([CITY.lng - 0.01, CITY.lat - 0.01, CITY.lng + 0.01, CITY.lat + 0.01])
  })
})

describe('region ↔ viewport', () => {
  it('round-trips a viewport through a region', () => {
    const region = regionForView({ center: CITY, zoom: 11 })
    expect(region.latitude).toBe(CITY.lat)
    expect(region.longitude).toBe(CITY.lng)
    expect(zoomForRegion(region)).toBeCloseTo(11, 5)
    expect(region.latitudeDelta / region.longitudeDelta).toBeCloseTo(DEFAULT_ASPECT, 5)
  })

  it('caps the world region at the globe and never divides by zero', () => {
    const world = regionForView(WORLD_VIEW)
    expect(world.longitudeDelta).toBeLessThanOrEqual(360)
    expect(zoomForRegion({ longitudeDelta: 0 })).toBeGreaterThan(20)
    expect(zoomForRegion({ longitudeDelta: 360 })).toBe(0)
  })

  it('derives the same bounds the query takes', () => {
    const region = { latitude: 37.77, longitude: -122.42, latitudeDelta: 0.2, longitudeDelta: 0.1 }
    const bounds = boundsForRegion(region)
    expect(bounds[0]).toBeCloseTo(-122.47, 6)
    expect(bounds[1]).toBeCloseTo(37.67, 6)
    expect(bounds[2]).toBeCloseTo(-122.37, 6)
    expect(bounds[3]).toBeCloseTo(37.87, 6)
    const state = moveStateForRegion(region)
    expect(state.center).toEqual({ lat: 37.77, lng: -122.42 })
    expect(state.bounds).toEqual(boundsForRegion(region))
  })
})

describe('light style', () => {
  it('hides points of interest and paints only palette colours', () => {
    const palette = {
      background: '#FFFFFF',
      subtleFill: '#F6F7F8',
      separator: '#ECEDEF',
      textSecondary: '#72757A',
    }
    const style = lightMapStyle(palette)
    expect(style.some((rule) => rule.featureType === 'poi')).toBe(true)
    const colours = style
      .flatMap((rule) => rule.stylers.map((s) => s['color']))
      .filter((c) => c !== undefined)
    expect(colours.every((c) => Object.values(palette).includes(String(c)))).toBe(true)
  })
})
