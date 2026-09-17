import { colors } from '@earth/ui'
import { describe, expect, it } from 'vitest'

import {
  BASEMAP_BUDGET_BYTES,
  GRATICULE_LAT_LIMIT_DEG,
  GRATICULE_STEP_DEG,
  LAND_MAX_ZOOM,
  LAND_PRECISION,
  POLE_EDGE_LAT,
  basemapStyle,
  graticule,
  landGeoJson,
} from './basemap'

const decimalsOf = (value: number): boolean =>
  Math.abs(value * 10 ** LAND_PRECISION - Math.round(value * 10 ** LAND_PRECISION)) < 1e-6

describe('landGeoJson', () => {
  const land = landGeoJson()

  it('is one MultiPolygon of the continents, in range and rounded', () => {
    expect(land.geometry.type).toBe('MultiPolygon')
    expect(land.geometry.coordinates.length).toBeGreaterThan(100)
    let points = 0
    for (const polygon of land.geometry.coordinates) {
      for (const ring of polygon) {
        for (const [lng, lat] of ring) {
          points += 1
          expect(lng).toBeGreaterThanOrEqual(-540)
          expect(lng).toBeLessThanOrEqual(540)
          expect(lat).toBeGreaterThanOrEqual(-90)
          expect(lat).toBeLessThanOrEqual(90)
          expect(decimalsOf(lng ?? 0)).toBe(true)
          expect(decimalsOf(lat ?? 0)).toBe(true)
        }
      }
    }
    expect(points).toBeGreaterThan(5_000)
  })

  it('has no ring with repeated neighbours or fewer than four points, and every ring closed', () => {
    for (const polygon of land.geometry.coordinates) {
      for (const ring of polygon) {
        expect(ring.length).toBeGreaterThanOrEqual(4)
        expect(ring[0]).toEqual(ring[ring.length - 1])
        for (let i = 1; i < ring.length; i += 1) {
          expect(ring[i]).not.toEqual(ring[i - 1])
        }
      }
    }
  })

  it('never jumps across the antimeridian, and keeps the Caspian as a hole', () => {
    let holes = 0
    for (const polygon of land.geometry.coordinates) {
      holes += polygon.length - 1
      for (const ring of polygon) {
        for (let i = 1; i < ring.length; i += 1) {
          const [lng, lat] = ring[i] ?? [0, 0]
          const [prevLng] = ring[i - 1] ?? [0, 0]
          // Only Antarctica's edge along the pole may still span the world.
          if (Math.abs(lat ?? 0) >= POLE_EDGE_LAT) continue
          expect(Math.abs((lng ?? 0) - (prevLng ?? 0))).toBeLessThanOrEqual(180)
        }
      }
    }
    expect(holes).toBeGreaterThanOrEqual(1)
    // Unwrapped rings may run past ±180 by less than a world.
    for (const polygon of land.geometry.coordinates) {
      for (const ring of polygon) {
        for (const [lng] of ring) {
          expect(Math.abs(lng ?? 0)).toBeLessThan(540)
        }
      }
    }
  })

  it('is decoded once per process', () => {
    expect(landGeoJson()).toBe(land)
  })
})

describe('graticule', () => {
  it('draws every meridian and parallel as one two-point line', () => {
    const lines = graticule()
    const meridians = 360 / GRATICULE_STEP_DEG + 1
    const parallels = (2 * GRATICULE_LAT_LIMIT_DEG) / GRATICULE_STEP_DEG + 1
    expect(lines.features).toHaveLength(meridians + parallels)
    for (const feature of lines.features) {
      expect(feature.geometry.coordinates).toHaveLength(2)
    }
  })
})

describe('basemapStyle', () => {
  const style = basemapStyle()
  const json = JSON.stringify(style)

  it('is a version-8 style with inline sources only — nothing to fetch', () => {
    expect(style.version).toBe(8)
    expect(Object.keys(style.sources)).toEqual(['land', 'graticule'])
    for (const source of Object.values(style.sources)) {
      expect(source.type).toBe('geojson')
      expect(typeof source.data).toBe('object')
    }
    expect(json).not.toMatch(/https?:\/\/|"tiles"|"url"/)
  })

  it('layers water, land, coast and graticule in that order, in the palette', () => {
    expect(style.layers.map((layer) => layer.id)).toEqual([
      'background',
      'land',
      'coast',
      'graticule',
    ])
    expect(json).toContain(colors.background)
    expect(json).toContain(colors.subtleFill)
    expect(json).toContain(colors.separator)
    expect(json).not.toContain(colors.earthAccent)
    expect(json).not.toContain(colors.live)
    for (const id of ['coast', 'graticule']) {
      expect(style.layers.find((layer) => layer.id === id)?.maxzoom).toBe(LAND_MAX_ZOOM)
    }
  })

  it('stays within one cheap request', () => {
    expect(json.length).toBeLessThan(BASEMAP_BUDGET_BYTES)
    expect(style.metadata['earth:basemap']).toBe('land-110m')
    expect(style.metadata['earth:surface']).toBe(colors.background)
  })
})
