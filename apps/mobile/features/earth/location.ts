/**
 * The device side of location (spec §74): `expo-location` behind the structural `LocationLike`
 * the pure module takes, a foreground position watch for the share updater, and the system
 * settings door. This is the only file under `features/earth` / `components/{map,location}`
 * that imports `expo-location`. When-in-use only — no background permission is ever requested.
 * A position is handed to the caller and never stored, logged or sent to analytics.
 */
import * as Linking from 'expo-linking'
import * as Location from 'expo-location'

import {
  LOCATION_ACCURACY,
  type LocationAccuracyLike,
  type LocationLike,
  type WatchPlan,
} from './state/location'
import type { LatLng } from './state/view'

function toAccuracy(value: LocationAccuracyLike | undefined): Location.LocationAccuracy {
  switch (value) {
    case LOCATION_ACCURACY.high:
      return Location.LocationAccuracy.High
    case LOCATION_ACCURACY.balanced:
      return Location.LocationAccuracy.Balanced
    case LOCATION_ACCURACY.low:
    case undefined:
      return Location.LocationAccuracy.Low
    default: {
      const exhaustive: never = value
      throw new Error(`Unknown accuracy: ${String(exhaustive)}`)
    }
  }
}

let cached: LocationLike | null = null

/** `expo-location` as the pure module sees it. */
export function deviceLocation(): LocationLike {
  cached ??= {
    getForegroundPermissionsAsync: () => Location.getForegroundPermissionsAsync(),
    requestForegroundPermissionsAsync: () => Location.requestForegroundPermissionsAsync(),
    getCurrentPositionAsync: (options) =>
      Location.getCurrentPositionAsync({ accuracy: toAccuracy(options?.accuracy) }),
    hasServicesEnabledAsync: () => Location.hasServicesEnabledAsync(),
  }
  return cached
}

export interface PositionWatch {
  remove(): void
}

/**
 * Foreground position updates for the share updater. Never asks for permission (an explicit
 * share did that); `null` when the permission is not granted, so a revoked permission stops
 * every update on its own.
 */
export async function watchPosition(
  plan: Pick<WatchPlan, 'accuracy' | 'timeInterval' | 'distanceInterval'>,
  onFix: (position: LatLng) => void,
): Promise<PositionWatch | null> {
  let granted = false
  try {
    granted = (await Location.getForegroundPermissionsAsync()).granted
  } catch {
    granted = false
  }
  if (!granted) return null
  try {
    const subscription = await Location.watchPositionAsync(
      {
        accuracy: toAccuracy(plan.accuracy),
        timeInterval: plan.timeInterval,
        distanceInterval: plan.distanceInterval,
      },
      (fix) => onFix({ lat: fix.coords.latitude, lng: fix.coords.longitude }),
    )
    return { remove: () => subscription.remove() }
  } catch {
    return null
  }
}

/** The app's page in the system Settings (a denied permission is changed there). */
export function openSystemSettings(): Promise<boolean> {
  return Linking.openSettings()
    .then(() => true)
    .catch(() => false)
}
