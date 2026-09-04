/**
 * Explicit device position (spec §74): asked only on the Earth map ("Use my location") or an
 * explicit share, when-in-use only, never stored by the client, never sent to analytics.
 * Structural over `expo-location` so the permission and error mapping is unit-tested, and so
 * the share updater's decisions (accuracy per precision, when to watch, when to stop) are pure.
 */
import type { LocationPrecision } from '@earth/domain'

import { mapCopy } from '../copy'
import type { MyShare } from './myShares'
import type { LatLng } from './view'

export const GEOLOCATION_FAILURES = ['unsupported', 'denied', 'unavailable', 'timeout'] as const
export type GeolocationFailure = (typeof GEOLOCATION_FAILURES)[number]

export type PositionResult =
  | { readonly ok: true; readonly position: LatLng }
  | { readonly ok: false; readonly failure: GeolocationFailure }

/** `expo-location`'s `PermissionStatus` values, spelled once. */
export const PERMISSION_STATUS = {
  granted: 'granted',
  undetermined: 'undetermined',
  denied: 'denied',
} as const
export type PermissionStatusLike = (typeof PERMISSION_STATUS)[keyof typeof PERMISSION_STATUS]

export interface PermissionResponseLike {
  readonly status: PermissionStatusLike | string
  readonly granted: boolean
  /** `false` when the system will not ask again (the person must open Settings). */
  readonly canAskAgain?: boolean
}

export interface PositionLike {
  readonly coords: { readonly latitude: number; readonly longitude: number }
}

/**
 * `expo-location`'s accuracy levels (its `LocationAccuracy` enum): `Low` ≈ 1 km, `Balanced` ≈
 * 100 m, `High` ≈ 10 m. Spelled here so the pure module never imports the native package.
 */
export const LOCATION_ACCURACY = { low: 2, balanced: 3, high: 4 } as const
export type LocationAccuracyLike = (typeof LOCATION_ACCURACY)[keyof typeof LOCATION_ACCURACY]

export interface PositionOptionsLike {
  readonly accuracy?: LocationAccuracyLike
}

/** The two `expo-location` calls a one-shot position needs, structurally. */
export interface LocationLike {
  getForegroundPermissionsAsync(): Promise<PermissionResponseLike>
  requestForegroundPermissionsAsync(): Promise<PermissionResponseLike>
  getCurrentPositionAsync(options?: PositionOptionsLike): Promise<PositionLike>
  hasServicesEnabledAsync?(): Promise<boolean>
}

/** The accuracy a share needs: only a precise share reads a precise position (spec §74). */
export function accuracyForPrecision(precision: LocationPrecision | null): LocationAccuracyLike {
  switch (precision) {
    case 'precise':
      return LOCATION_ACCURACY.high
    case 'approximate':
      return LOCATION_ACCURACY.balanced
    case 'city':
    case null:
      return LOCATION_ACCURACY.low
    default: {
      const exhaustive: never = precision
      throw new Error(`Unknown precision: ${String(exhaustive)}`)
    }
  }
}

/** The accuracy the whole set of shares needs: the most precise one decides. */
export function accuracyForShares(
  shares: readonly Pick<MyShare, 'precision'>[],
): LocationAccuracyLike {
  if (shares.some((share) => share.precision === 'precise')) return LOCATION_ACCURACY.high
  if (shares.some((share) => share.precision === 'approximate')) return LOCATION_ACCURACY.balanced
  return LOCATION_ACCURACY.low
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

export interface RequestPositionOptions {
  readonly precision?: LocationPrecision | null
  readonly timeoutMs?: number
  /** Ask the system when the permission is undetermined (an explicit gesture is behind this). */
  readonly requestPermission?: boolean
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * One position, once. Permission is checked and — behind an explicit gesture — requested
 * (when-in-use only; never background). Any failure is reported, never thrown.
 */
export async function requestPosition(
  location: LocationLike | null,
  options: RequestPositionOptions = {},
): Promise<PositionResult> {
  if (location === null) return { ok: false, failure: 'unsupported' }
  const requestPermission = options.requestPermission ?? true
  try {
    let permission = await location.getForegroundPermissionsAsync()
    if (
      !permission.granted &&
      requestPermission &&
      permission.status !== PERMISSION_STATUS.denied
    ) {
      permission = await location.requestForegroundPermissionsAsync()
    } else if (!permission.granted && requestPermission && permission.canAskAgain !== false) {
      permission = await location.requestForegroundPermissionsAsync()
    }
    if (!permission.granted) return { ok: false, failure: 'denied' }
    if (location.hasServicesEnabledAsync !== undefined) {
      const enabled = await location.hasServicesEnabledAsync()
      if (!enabled) return { ok: false, failure: 'unavailable' }
    }
    const position = await withTimeout(
      location.getCurrentPositionAsync({
        accuracy: accuracyForPrecision(options.precision ?? null),
      }),
      options.timeoutMs ?? POSITION_TIMEOUT_MS,
    )
    return {
      ok: true,
      position: { lat: position.coords.latitude, lng: position.coords.longitude },
    }
  } catch (error) {
    return {
      ok: false,
      failure: error instanceof Error && error.message === 'timeout' ? 'timeout' : 'unavailable',
    }
  }
}

// ---------------------------------------------------------------------------
// Periodic updates while foregrounded
// ---------------------------------------------------------------------------

/** How often at most a share's position is refreshed while the app is in front. */
export const SHARE_UPDATE_INTERVAL_MS = 60_000
/** Metres the device must move before another update is worth sending. */
export const SHARE_UPDATE_DISTANCE_M = 25

export interface WatchPlan {
  readonly accuracy: LocationAccuracyLike
  readonly timeInterval: number
  readonly distanceInterval: number
  /** Ids of the shares to update on every fix. */
  readonly shareIds: readonly string[]
  /** When the plan should be re-evaluated on its own (a share ends), or `null`. */
  readonly until: number | null
}

/**
 * What to watch, given the shares that still need positions: `null` means stop (nothing to
 * update, revoked, all expired, or the app is not in front). Pure; the hook applies it.
 */
export function watchPlan(
  shares: readonly MyShare[],
  now: number,
  foregrounded: boolean,
): WatchPlan | null {
  if (!foregrounded) return null
  const due = shares.filter(
    (share) => share.precision !== 'city' && new Date(share.expiresAt).getTime() > now,
  )
  if (due.length === 0) return null
  let until: number | null = null
  for (const share of due) {
    const at = new Date(share.expiresAt).getTime()
    if (until === null || at < until) until = at
  }
  return {
    accuracy: accuracyForShares(due),
    timeInterval: SHARE_UPDATE_INTERVAL_MS,
    distanceInterval: SHARE_UPDATE_DISTANCE_M,
    shareIds: due.map((share) => share.id),
    until,
  }
}
