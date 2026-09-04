/**
 * Map objects (`MapObjectsDto`) → markers, pure. Positions come from the server already reduced
 * to what the viewer may know (spec §74–§76; DB_API §5): a Live is placed on its Place or its
 * area centroid, never on a device; a friend's share is degraded by its precision. This module
 * never invents a coordinate: a Live with `precision = 'none'` has no marker at all, and every
 * emitted position is exactly the DTO's.
 */
import type {
  AreaPrecision,
  LiveCardDto,
  LocationPrecision,
  MapFriendDto,
  MapLiveDto,
  MapMomentDto,
  MapObjectsDto,
  PlaceDto,
  PlaceId,
  PostId,
  RoomId,
} from '@earth/domain'

import type { LatLng } from './view'

export interface LiveFace {
  readonly displayName: string
  readonly avatarUrl: string | null
}

export interface LiveMarker {
  readonly kind: 'live'
  readonly id: string
  readonly roomId: RoomId
  readonly position: LatLng
  readonly title: string
  readonly participantCount: number
  /** `place` when the initiator attached a public Place; otherwise the area the centroid stands for. */
  readonly precision: Exclude<AreaPrecision, 'none'>
  /** From `GET /api/live` when the room is in the viewer's Live list; empty otherwise. */
  readonly faces: readonly LiveFace[]
}

export interface PlaceMarker {
  readonly kind: 'place'
  readonly id: string
  readonly placeId: PlaceId
  readonly position: LatLng
  readonly name: string
  readonly areaName: string | null
  readonly category: string | null
}

export interface FriendMarker {
  readonly kind: 'friend'
  readonly id: string
  readonly humanId: string
  readonly position: LatLng
  readonly displayName: string
  readonly avatarUrl: string | null
  readonly precision: LocationPrecision
  readonly expiresAt: string
}

export interface MomentMarker {
  readonly kind: 'moment'
  readonly id: string
  readonly postId: PostId
  readonly position: LatLng
  readonly authorDisplayName: string
}

export type MapMarker = LiveMarker | PlaceMarker | FriendMarker | MomentMarker

/** The four object kinds SCREEN 20 draws; a cluster is a group of Lives. */
export const MARKER_KINDS = ['live', 'place', 'friend', 'moment'] as const
export type MarkerKind = (typeof MARKER_KINDS)[number]

export interface MarkerSets {
  readonly lives: readonly LiveMarker[]
  readonly places: readonly PlaceMarker[]
  readonly friends: readonly FriendMarker[]
  readonly moments: readonly MomentMarker[]
}

export const EMPTY_MARKERS: MarkerSets = { lives: [], places: [], friends: [], moments: [] }

export const liveMarkerId = (roomId: string): string => `live:${roomId}`
export const placeMarkerId = (placeId: string): string => `place:${placeId}`
export const friendMarkerId = (humanId: string): string => `friend:${humanId}`
export const momentMarkerId = (postId: string): string => `moment:${postId}`

/** Faces for the Lives the viewer's Live list also names (joined by room id). */
export function facesByRoom(
  cards: readonly LiveCardDto[],
): ReadonlyMap<string, readonly LiveFace[]> {
  const out = new Map<string, readonly LiveFace[]>()
  for (const card of cards) {
    out.set(
      card.roomId,
      card.participantNames.map((displayName, index) => ({
        displayName,
        avatarUrl: card.participantAvatars[index] ?? null,
      })),
    )
  }
  return out
}

/** A Live marker, or `null` when the server gave the room no place to stand (`precision = 'none'`). */
export function liveMarker(
  live: MapLiveDto,
  faces: ReadonlyMap<string, readonly LiveFace[]>,
): LiveMarker | null {
  if (live.precision === 'none') return null
  return {
    kind: 'live',
    id: liveMarkerId(live.roomId),
    roomId: live.roomId,
    position: { lat: live.lat, lng: live.lng },
    title: live.title,
    participantCount: live.participantCount,
    precision: live.precision,
    faces: faces.get(live.roomId) ?? [],
  }
}

export function placeMarker(place: PlaceDto): PlaceMarker {
  return {
    kind: 'place',
    id: placeMarkerId(place.id),
    placeId: place.id,
    position: { lat: place.lat, lng: place.lng },
    name: place.name,
    areaName: place.areaName,
    category: place.category,
  }
}

export function friendMarker(friend: MapFriendDto): FriendMarker {
  return {
    kind: 'friend',
    id: friendMarkerId(friend.humanId),
    humanId: friend.humanId,
    position: { lat: friend.lat, lng: friend.lng },
    displayName: friend.displayName,
    avatarUrl: friend.avatarUrl,
    precision: friend.precision,
    expiresAt: friend.expiresAt,
  }
}

export function momentMarker(moment: MapMomentDto): MomentMarker {
  return {
    kind: 'moment',
    id: momentMarkerId(moment.postId),
    postId: moment.postId,
    position: { lat: moment.lat, lng: moment.lng },
    authorDisplayName: moment.authorDisplayName,
  }
}

/** Every marker set for a `map_objects` answer; `cards` (from `GET /api/live`) add faces to Lives. */
export function toMarkers(objects: MapObjectsDto, cards: readonly LiveCardDto[] = []): MarkerSets {
  const faces = facesByRoom(cards)
  const lives: LiveMarker[] = []
  for (const live of objects.lives) {
    const marker = liveMarker(live, faces)
    if (marker !== null) lives.push(marker)
  }
  return {
    lives,
    places: objects.places.map(placeMarker),
    friends: objects.friends.map(friendMarker),
    moments: objects.moments.map(momentMarker),
  }
}

/** Shares that have not expired yet (the server sweeps, the client stops drawing in between). */
export function activeFriends(friends: readonly FriendMarker[], now: number): FriendMarker[] {
  return friends.filter((friend) => new Date(friend.expiresAt).getTime() > now)
}

/**
 * Precision ring radius (pt) around a shared friend: a City share is a wide, soft area;
 * approximate a smaller one; precise none. Never a coloured border around the face.
 */
export const FRIEND_HALO_PT = {
  city: 72,
  approximate: 48,
  precise: 0,
} as const satisfies Record<LocationPrecision, number>

export function friendHaloPt(precision: LocationPrecision): number {
  return FRIEND_HALO_PT[precision]
}

/** The Live objects the rooms tier positioned by an area centroid (not a Place). */
export function isAreaLevel(marker: LiveMarker): boolean {
  return marker.precision !== 'place'
}

/** The box around the objects of a set — used to bring a whole answer into view. */
export function positionsOf(markers: MarkerSets): LatLng[] {
  return [
    ...markers.lives.map((m) => m.position),
    ...markers.friends.map((m) => m.position),
    ...markers.places.map((m) => m.position),
    ...markers.moments.map((m) => m.position),
  ]
}
