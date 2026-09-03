/**
 * Web microcopy for location sharing (spec §75) at moments the spec leaves unnamed. The named
 * strings — "Share with Weekend Crew", "1 hour", "Tonight", "Custom" — come from `@earth/ui`.
 */
import type { LocationPrecision } from '@earth/domain'

export const locationCopy = {
  precision: {
    city: 'City',
    approximate: 'Approximate',
    precise: 'Precise',
  } as const satisfies Record<LocationPrecision, string>,
  precisionHint: {
    city: 'Only which city you are in.',
    approximate: 'Within a few blocks.',
    precise: 'Exactly where you are.',
  } as const satisfies Record<LocationPrecision, string>,
  precisionLabel: 'How precisely',
  durationLabel: 'For how long',
  customLabel: 'Custom length',
  hours: (count: number): string => (count === 1 ? '1 hour' : `${count} hours`),
  minutes: (count: number): string => `${count} min`,
  share: 'Share',
  chooseAudience: 'Share with',
  noAudiences: 'Sharing starts with a group. Join or start one first.',
  sharingOff: 'Location sharing is not open yet.',
  boundedNote: 'Sharing ends on its own. Never forever.',
  positionNeeded: 'Earth needs your location to share it.',
  sharedWith: (name: string): string => `Sharing with ${name}`,
  until: (time: string): string => `until ${time}`,
  stopSharing: 'Stop sharing',
  stopped: 'Stopped sharing.',
  yourShares: 'You are sharing',
  friendsSharing: 'Sharing with you',
  nothingShared: "You're not sharing where you are.",
  noFriendsSharing: 'Nobody is sharing with you right now.',
  showOnMap: (name: string): string => `Show ${name} on the map`,
} as const

export type LocationCopy = typeof locationCopy
