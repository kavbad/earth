/**
 * Explicit, one-shot device position (spec §74): asked only on the Earth map or an explicit
 * share, never stored by the client, never sent to analytics. Structural over
 * `navigator.geolocation` so the error mapping is unit-tested.
 */
import type { LatLng } from '../map/types'
import { mapCopy } from '../map/copy'

export interface GeolocationPositionLike {
  readonly coords: { readonly latitude: number; readonly longitude: number }
}

export interface GeolocationErrorLike {
  readonly code: number
}

export interface GeolocationLike {
  getCurrentPosition(
    success: (position: GeolocationPositionLike) => void,
    error?: (error: GeolocationErrorLike) => void,
    options?: { enableHighAccuracy?: boolean; timeout?: number; maximumAge?: number },
  ): void
}

export const GEOLOCATION_FAILURES = ['unsupported', 'denied', 'unavailable', 'timeout'] as const
export type GeolocationFailure = (typeof GEOLOCATION_FAILURES)[number]

export type PositionResult =
  | { readonly ok: true; readonly position: LatLng }
  | { readonly ok: false; readonly failure: GeolocationFailure }

/** W3C Geolocation error codes. */
export const GEOLOCATION_ERROR_CODES = { denied: 1, unavailable: 2, timeout: 3 } as const

export function failureFromCode(code: number): GeolocationFailure {
  switch (code) {
    case GEOLOCATION_ERROR_CODES.denied:
      return 'denied'
    case GEOLOCATION_ERROR_CODES.timeout:
      return 'timeout'
    default:
      return 'unavailable'
  }
}

export function messageForFailure(failure: GeolocationFailure): string {
  switch (failure) {
    case 'unsupported':
      return mapCopy.locationUnsupported
    case 'denied':
      return mapCopy.locationDenied
    case 'timeout':
    case 'unavailable':
      return mapCopy.locationUnavailable
    default: {
      const exhaustive: never = failure
      throw new Error(`Unknown geolocation failure: ${String(exhaustive)}`)
    }
  }
}

export const POSITION_TIMEOUT_MS = 15_000
export const POSITION_MAX_AGE_MS = 60_000

export interface RequestPositionOptions {
  readonly highAccuracy?: boolean
  readonly timeoutMs?: number
}

export function requestPosition(
  geolocation: GeolocationLike | undefined,
  options: RequestPositionOptions = {},
): Promise<PositionResult> {
  if (geolocation === undefined) return Promise.resolve({ ok: false, failure: 'unsupported' })
  return new Promise((resolve) => {
    geolocation.getCurrentPosition(
      (position) =>
        resolve({
          ok: true,
          position: { lat: position.coords.latitude, lng: position.coords.longitude },
        }),
      (error) => resolve({ ok: false, failure: failureFromCode(error.code) }),
      {
        enableHighAccuracy: options.highAccuracy ?? false,
        timeout: options.timeoutMs ?? POSITION_TIMEOUT_MS,
        maximumAge: POSITION_MAX_AGE_MS,
      },
    )
  })
}

/** The browser's geolocation, when there is one. */
export function browserGeolocation(): GeolocationLike | undefined {
  if (typeof navigator === 'undefined') return undefined
  return navigator.geolocation ?? undefined
}
