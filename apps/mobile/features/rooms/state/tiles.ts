/**
 * Room reducer: Earth's `RoomDto` participants and `subscribeRoom` deltas → the ordered list of
 * stage tiles (SCREEN 14). The order is stable across updates so tiles never shuffle when someone
 * joins, leaves or changes media: newcomers are appended, leavers removed, everyone else keeps
 * their slot. The LiveKit SDK only supplies tracks and speaking state on top (`RoomStage`).
 *
 * Pure: the same reducer drives the screen and the tests.
 */
import {
  type MediaIdentity,
  type MediaState,
  type ParticipantRole,
  type RoomDto,
  type RoomParticipantDto,
  type RoomVisibility,
  mediaIdentityForGuest,
  mediaIdentityForHuman,
} from '@earth/domain'
import type { RoomParticipantDelta } from '@earth/realtime'

import { isPublishing } from './consent'

export interface RoomTile {
  /** `room_participants.id`. */
  readonly id: string
  /** LiveKit identity (`h:<humanId>` / `g:<guestSessionId>`) to look tracks up by. */
  readonly identity: MediaIdentity
  readonly displayName: string
  readonly avatarUrl: string | null
  readonly isGuest: boolean
  readonly isSelf: boolean
  readonly mediaState: Exclude<MediaState, 'watching'>
  readonly role: ParticipantRole
  readonly consentLevel: RoomVisibility
}

export interface TilesState {
  /** Tile ids in display order. */
  readonly order: readonly string[]
  readonly byId: Readonly<Record<string, RoomTile>>
}

export const EMPTY_TILES: TilesState = { order: [], byId: {} }

export type TilesAction =
  | {
      readonly type: 'snapshot'
      readonly room: Pick<RoomDto, 'participants'>
      readonly selfParticipantId: string | null
    }
  | {
      readonly type: 'deltas'
      readonly deltas: readonly RoomParticipantDelta[]
      readonly selfParticipantId: string | null
    }
  | { readonly type: 'reset' }

export function participantIdentity(
  participant: Pick<RoomParticipantDto, 'humanId' | 'guestSessionId'>,
): MediaIdentity | null {
  if (participant.humanId !== null) return mediaIdentityForHuman(participant.humanId)
  if (participant.guestSessionId !== null) return mediaIdentityForGuest(participant.guestSessionId)
  return null
}

function toMs(value: string): number {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
}

/** Join order (then id) — the order tiles first appear in when a snapshot arrives. */
export function compareByJoin(a: RoomParticipantDto, b: RoomParticipantDto): number {
  const diff = toMs(a.joinedAt) - toMs(b.joinedAt)
  if (diff !== 0) return diff < 0 ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** A publishing participant as a tile, or `null` when they are not on stage. */
export function tileFor(
  participant: RoomParticipantDto,
  selfParticipantId: string | null,
): RoomTile | null {
  if (!isPublishing(participant) || participant.mediaState === 'watching') return null
  const identity = participantIdentity(participant)
  if (identity === null) return null
  return {
    id: participant.id,
    identity,
    displayName: participant.displayName,
    avatarUrl: participant.avatarUrl,
    isGuest: participant.isGuest,
    isSelf: participant.id === selfParticipantId,
    mediaState: participant.mediaState,
    role: participant.role,
    consentLevel: participant.audienceConsentLevel,
  }
}

function sameTile(a: RoomTile, b: RoomTile): boolean {
  return (
    a.identity === b.identity &&
    a.displayName === b.displayName &&
    a.avatarUrl === b.avatarUrl &&
    a.isGuest === b.isGuest &&
    a.isSelf === b.isSelf &&
    a.mediaState === b.mediaState &&
    a.role === b.role &&
    a.consentLevel === b.consentLevel
  )
}

function upsert(state: TilesState, tile: RoomTile): TilesState {
  const existing = state.byId[tile.id]
  if (existing !== undefined) {
    if (sameTile(existing, tile)) return state
    return { order: state.order, byId: { ...state.byId, [tile.id]: tile } }
  }
  return { order: [...state.order, tile.id], byId: { ...state.byId, [tile.id]: tile } }
}

function remove(state: TilesState, id: string): TilesState {
  if (state.byId[id] === undefined) return state
  const byId = { ...state.byId }
  delete byId[id]
  return { order: state.order.filter((tileId) => tileId !== id), byId }
}

/**
 * Reconciles a full snapshot: surviving tiles keep their slot (updated in place), tiles no longer
 * publishing are dropped, newcomers are appended in join order.
 */
export function applySnapshot(
  state: TilesState,
  room: Pick<RoomDto, 'participants'>,
  selfParticipantId: string | null,
): TilesState {
  const sorted = [...room.participants].sort(compareByJoin)
  const next = new Map<string, RoomTile>()
  for (const participant of sorted) {
    const tile = tileFor(participant, selfParticipantId)
    if (tile !== null) next.set(tile.id, tile)
  }
  const order: string[] = []
  const byId: Record<string, RoomTile> = {}
  let changed = false
  for (const id of state.order) {
    const tile = next.get(id)
    if (tile === undefined) {
      changed = true
      continue
    }
    const previous = state.byId[id]
    if (previous === undefined || !sameTile(previous, tile)) changed = true
    order.push(id)
    byId[id] = previous !== undefined && sameTile(previous, tile) ? previous : tile
    next.delete(id)
  }
  for (const tile of next.values()) {
    changed = true
    order.push(tile.id)
    byId[tile.id] = tile
  }
  return changed ? { order, byId } : state
}

/** Applies participant deltas from `subscribeRoom` one by one, in order. */
export function applyDeltas(
  state: TilesState,
  deltas: readonly RoomParticipantDelta[],
  selfParticipantId: string | null,
): TilesState {
  let next = state
  for (const delta of deltas) {
    switch (delta.kind) {
      case 'participant_left':
        next = remove(next, delta.participant.id)
        break
      case 'participant_joined':
      case 'media_state_changed':
      case 'role_changed':
      case 'consent_changed': {
        const tile = tileFor(delta.participant, selfParticipantId)
        next = tile === null ? remove(next, delta.participant.id) : upsert(next, tile)
        break
      }
    }
  }
  return next
}

export function tilesReducer(state: TilesState, action: TilesAction): TilesState {
  switch (action.type) {
    case 'snapshot':
      return applySnapshot(state, action.room, action.selfParticipantId)
    case 'deltas':
      return applyDeltas(state, action.deltas, action.selfParticipantId)
    case 'reset':
      return state === EMPTY_TILES ? state : EMPTY_TILES
  }
}

/** The tiles in display order. */
export function tileList(state: TilesState): RoomTile[] {
  const out: RoomTile[] = []
  for (const id of state.order) {
    const tile = state.byId[id]
    if (tile !== undefined) out.push(tile)
  }
  return out
}
