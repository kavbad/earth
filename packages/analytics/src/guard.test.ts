import { describe, expect, it } from 'vitest'

import {
  findForbiddenPropertyKeys,
  FORBIDDEN_PROPERTY_TOKENS,
  isCoordinateLikeValue,
  isForbiddenPropertyKey,
  stripForbiddenProperties,
} from './guard'

describe('property guard — keys', () => {
  it('rejects coordinate keys in any casing or word position', () => {
    for (const key of [
      'lat',
      'lng',
      'lon',
      'latitude',
      'longitude',
      'coords',
      'coordinates',
      'coord',
      'coordinate',
      'LAT',
      'userLat',
      'start_lng',
      'exact-latitude',
      'geo.coords',
      'HomeLongitude',
    ]) {
      expect(isForbiddenPropertyKey(key), key).toBe(true)
    }
  })

  it('rejects compound coordinate words that carry no camelCase boundary', () => {
    for (const key of ['latlng', 'latlon', 'lnglat', 'lonlat', 'LatLng', 'LATLNG', 'user_latlng']) {
      expect(isForbiddenPropertyKey(key), key).toBe(true)
    }
  })

  it('rejects coordinate words glued to digits', () => {
    for (const key of ['lat1', 'lng2', 'LNG2', 'lat0', 'point1Lat', 'lat_e7', 'latitudeE7']) {
      expect(isForbiddenPropertyKey(key), key).toBe(true)
    }
  })

  it('rejects other exact-location vocabulary', () => {
    for (const key of [
      'gps',
      'gpsFix',
      'geo',
      'geohash',
      'geolocation',
      'geoPoint',
      'geopoint',
      'geometry',
      'altitude',
    ]) {
      expect(isForbiddenPropertyKey(key), key).toBe(true)
    }
    for (const token of FORBIDDEN_PROPERTY_TOKENS) expect(isForbiddenPropertyKey(token)).toBe(true)
  })

  it('allows keys that merely contain the letters', () => {
    for (const key of [
      'deliveryLatencyMs',
      'latency',
      'latest',
      'platform',
      'longRunning',
      'relation',
      'translation',
      'areaId',
      'areaPrecision',
      'lonely',
      'position',
      'retentionD7',
      'geography',
      'template',
      'd1',
    ]) {
      expect(isForbiddenPropertyKey(key), key).toBe(false)
    }
  })
})

describe('property guard — values', () => {
  it('recognises exact coordinate pairs in strings', () => {
    for (const value of [
      '37.7749,-122.4194',
      '37.7749, -122.4194',
      ' -122.4194 , 37.7749 ',
      'geo:37.7749,-122.4194',
      '+51.500729,-0.124625',
      '0.000,0.000',
    ]) {
      expect(isCoordinateLikeValue(value), value).toBe(true)
    }
  })

  it('leaves versions, counts, low-precision and out-of-range strings alone', () => {
    for (const value of [
      '1.2.3',
      '12,34',
      '37.77,-122.41',
      '37.7749',
      '200.000,200.000',
      '95.000,95.000',
      '2026-09-03T10:00:00.000Z',
      'friends',
      '',
    ]) {
      expect(isCoordinateLikeValue(value), value).toBe(false)
    }
    expect(isCoordinateLikeValue(37.7749)).toBe(false)
    expect(isCoordinateLikeValue(null)).toBe(false)
    expect(isCoordinateLikeValue(['37.7749,-122.4194'])).toBe(false)
  })

  it('flags coordinate-like values whatever the key, including inside arrays', () => {
    expect(
      findForbiddenPropertyKeys({
        area: '37.7749,-122.4194',
        tags: ['ok', 'geo:37.7749,-122.4194'],
        scope: 'city',
      }),
    ).toEqual(['area', 'tags'])
  })
})

describe('property guard — traversal', () => {
  it('finds forbidden keys at any depth as dotted paths, in document order', () => {
    expect(
      findForbiddenPropertyKeys({
        roomId: 'r',
        lat: 1,
        place: { name: 'x', coords: [1, 2] },
        nested: { deeper: { longitude: 3 } },
      }),
    ).toEqual(['lat', 'place.coords', 'nested.deeper.longitude'])
  })

  it('scans arrays of objects', () => {
    expect(
      findForbiddenPropertyKeys({
        places: [{ name: 'a' }, { lat: 1, lng: 2 }, { inner: [{ geohash: 'x' }] }],
      }),
    ).toEqual(['places[1].lat', 'places[1].lng', 'places[2].inner[0].geohash'])
  })

  it('ignores non-plain objects (Dates, class instances) rather than walking them', () => {
    class Point {
      lat = 1
    }
    expect(findForbiddenPropertyKeys({ when: new Date(0), point: new Point() })).toEqual([])
  })

  it('strips forbidden keys and values without touching the rest or the input', () => {
    const input = {
      roomId: 'r',
      lat: 1,
      lng: 2,
      meta: { ok: true, latitude: 5 },
      area: '37.7749,-122.4194',
      places: [{ name: 'a', coords: [1, 2] }, 'keep'],
    }
    const snapshot = JSON.stringify(input)
    expect(stripForbiddenProperties(input)).toEqual({
      roomId: 'r',
      meta: { ok: true },
      places: [{ name: 'a' }, 'keep'],
    })
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('a stripped object never trips the finder again', () => {
    const dirty = { a: { lat: 1, b: { lng: 2, c: 'ok' } }, d: [{ geo: 1 }], e: 'geo:1.000,2.000' }
    expect(findForbiddenPropertyKeys(stripForbiddenProperties(dirty))).toEqual([])
  })
})
