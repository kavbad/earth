/**
 * Web microcopy for SCREEN 20 at moments the spec leaves unnamed (accessible names, location
 * prompts, list lines). Everything the spec quotes (radius labels, "Share with …", durations,
 * "Couldn't refresh") comes from `@earth/ui`'s `copy` and is never restated here.
 */
import type { LocationPrecision, Scope } from '@earth/domain'

export const mapCopy = {
  mapLabel: 'Earth map',
  useMyLocation: 'Use my location',
  locating: 'Finding where you are…',
  locationDenied: "Earth can't see your location. You can allow it in your browser settings.",
  locationUnavailable: "Couldn't find where you are.",
  locationUnsupported: "This browser can't share a location.",
  needLocation: (scope: Scope): string =>
    scope === 'neighborhood'
      ? 'Set where you are to see your Neighborhood.'
      : 'Set where you are to see your City.',
  listView: 'List',
  mapView: 'Map',
  nothingHere: 'Nothing on the map here yet.',
  liveHere: (count: number): string => (count === 1 ? '1 live here' : `${count} live here`),
  participants: (count: number): string => (count === 1 ? '1 person' : `${count} people`),
  inArea: 'Nearby',
  momentBy: (name: string): string => `Moment by ${name}`,
  sections: {
    lives: 'Live',
    friends: 'Friends',
    places: 'Places',
    moments: 'Moments',
  },
  precision: {
    city: 'City',
    approximate: 'Approximate',
    precise: 'Precise',
  } as const satisfies Record<LocationPrecision, string>,
  sharingUntil: (time: string): string => `Sharing until ${time}`,
  shareWhereYouAre: 'Share where you are',
  guestsNoMap: 'The map is for people on Earth.',
  worldOff: 'The World map is not open yet.',
  openRoom: (title: string): string => `Open ${title}`,
  openPlace: (name: string): string => `Open ${name}`,
  zoomIn: 'Zoom in',
  loadingMap: 'Loading the map…',
  mapFailed: "The map couldn't load.",
} as const

export type MapCopy = typeof mapCopy
