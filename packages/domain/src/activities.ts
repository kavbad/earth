/**
 * Room activities — scaffold only (spec §132). No activity UI ships in V1; `MAFIA_ACTIVITY_ENABLED`
 * stays false. The interface exists so rooms can carry an activity later without a schema rewrite.
 */

export interface RoomActivity {
  id: string
  type: string
  state: unknown
}

/** Activity type identifier registered by a future activity module (for example `mafia`). */
export type RoomActivityType = string

export interface RoomActivityDefinition<TState = unknown> {
  type: RoomActivityType
  /** Initial state when the activity starts in a room. */
  initialState(): TState
  /** Whether the state is well-formed; used before persisting to `rooms.activity` (future). */
  isState(value: unknown): value is TState
}

/** Registry keyed by activity type. Empty in V1. */
export type RoomActivityRegistry = Readonly<Record<RoomActivityType, RoomActivityDefinition>>

export const ROOM_ACTIVITY_REGISTRY: RoomActivityRegistry = Object.freeze({})
