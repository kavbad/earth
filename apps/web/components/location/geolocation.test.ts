import { describe, expect, it } from 'vitest'

import { mapCopy } from '../map/copy'
import {
  GEOLOCATION_ERROR_CODES,
  type GeolocationLike,
  failureFromCode,
  messageForFailure,
  requestPosition,
} from './geolocation'

describe('requestPosition (spec §74: explicit, one-shot)', () => {
  it('resolves the coordinates once and asks for low accuracy by default', async () => {
    let asked: unknown = null
    const geo: GeolocationLike = {
      getCurrentPosition: (success, _error, options) => {
        asked = options
        success({ coords: { latitude: 37.76, longitude: -122.42 } })
      },
    }
    await expect(requestPosition(geo)).resolves.toEqual({
      ok: true,
      position: { lat: 37.76, lng: -122.42 },
    })
    expect(asked).toMatchObject({ enableHighAccuracy: false })
  })

  it('maps the W3C error codes and an absent API', async () => {
    const denied: GeolocationLike = {
      getCurrentPosition: (_s, error) => error?.({ code: GEOLOCATION_ERROR_CODES.denied }),
    }
    await expect(requestPosition(denied)).resolves.toEqual({ ok: false, failure: 'denied' })
    await expect(requestPosition(undefined)).resolves.toEqual({ ok: false, failure: 'unsupported' })
    expect(failureFromCode(GEOLOCATION_ERROR_CODES.timeout)).toBe('timeout')
    expect(failureFromCode(99)).toBe('unavailable')
  })

  it('explains each failure in the map copy', () => {
    expect(messageForFailure('denied')).toBe(mapCopy.locationDenied)
    expect(messageForFailure('unsupported')).toBe(mapCopy.locationUnsupported)
    expect(messageForFailure('timeout')).toBe(mapCopy.locationUnavailable)
  })
})
