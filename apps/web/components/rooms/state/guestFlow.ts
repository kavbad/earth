/**
 * Guest web flow (SCREEN 17 → 18 → 19) as a pure reducer: preview → name → joining → in room →
 * post-room → done. The component only dispatches; every rule (name validation, which step a
 * failure returns to, the outcome recorded on leaving) lives here and is unit-tested.
 */
import { GUEST_DISPLAY_NAME_MAX, type GuestSessionId, type MediaState, type RoomId } from '@earth/domain'
import type { GuestOutcome } from '@earth/analytics'

export const GUEST_STEPS = ['preview', 'name', 'joining', 'in_room', 'post_room', 'done'] as const
export type GuestStep = (typeof GUEST_STEPS)[number]

export interface GuestFlowState {
  readonly step: GuestStep
  readonly name: string
  /** The person asked for the camera preview; joining publishes camera when it was on. */
  readonly wantsCamera: boolean
  readonly error: GuestFlowError | null
  readonly guestSessionId: GuestSessionId | null
  readonly roomId: RoomId | null
  readonly joinedAt: number | null
  readonly outcome: GuestOutcome | null
}

export type GuestFlowError = 'name_missing' | 'join_failed' | 'link_unusable' | 'guests_disabled'

export type GuestFlowEvent =
  | { readonly type: 'start' }
  | { readonly type: 'name_changed'; readonly name: string }
  | { readonly type: 'camera_toggled'; readonly on: boolean }
  | { readonly type: 'submit' }
  | { readonly type: 'join_failed'; readonly error: Exclude<GuestFlowError, 'name_missing'> }
  | {
      readonly type: 'joined'
      readonly guestSessionId: GuestSessionId
      readonly roomId: RoomId
      readonly at: number
    }
  | { readonly type: 'left'; readonly outcome: GuestOutcome }
  | { readonly type: 'finish' }

export const INITIAL_GUEST_FLOW: GuestFlowState = {
  step: 'preview',
  name: '',
  wantsCamera: false,
  error: null,
  guestSessionId: null,
  roomId: null,
  joinedAt: null,
  outcome: null,
}

/** A usable Guest display name: trimmed, non-empty, at most `GUEST_DISPLAY_NAME_MAX`. */
export function normalizeGuestName(raw: string): string | null {
  const trimmed = raw.trim().replace(/\s+/g, ' ')
  if (trimmed.length === 0 || trimmed.length > GUEST_DISPLAY_NAME_MAX) return null
  return trimmed
}

export function guestFlowReducer(state: GuestFlowState, event: GuestFlowEvent): GuestFlowState {
  switch (event.type) {
    case 'start':
      return state.step === 'preview' ? { ...state, step: 'name', error: null } : state
    case 'name_changed':
      return { ...state, name: event.name, error: state.error === 'name_missing' ? null : state.error }
    case 'camera_toggled':
      return { ...state, wantsCamera: event.on }
    case 'submit': {
      if (state.step !== 'name') return state
      const name = normalizeGuestName(state.name)
      if (name === null) return { ...state, error: 'name_missing' }
      return { ...state, step: 'joining', name, error: null }
    }
    case 'join_failed':
      if (state.step !== 'joining') return state
      // A dead link or disabled Guests is final; anything else lets them try again.
      return event.error === 'join_failed'
        ? { ...state, step: 'name', error: event.error }
        : { ...state, step: 'preview', error: event.error }
    case 'joined':
      if (state.step !== 'joining') return state
      return {
        ...state,
        step: 'in_room',
        guestSessionId: event.guestSessionId,
        roomId: event.roomId,
        joinedAt: event.at,
        error: null,
      }
    case 'left':
      if (state.step !== 'in_room' && state.step !== 'joining') return state
      return { ...state, step: 'post_room', outcome: event.outcome }
    case 'finish':
      return state.step === 'post_room' ? { ...state, step: 'done' } : state
    default: {
      const exhaustive: never = event
      throw new Error(`Unknown guest flow event: ${String(exhaustive)}`)
    }
  }
}

/** The media state a Guest joins with (the RPC defaults to audio; camera only when previewed). */
export function guestJoinMediaState(state: Pick<GuestFlowState, 'wantsCamera'>): MediaState {
  return state.wantsCamera ? 'camera' : 'audio'
}

/** Time spent in the room for `guest_room_completed.durationMs`. */
export function guestDurationMs(state: Pick<GuestFlowState, 'joinedAt'>, now: number): number {
  return state.joinedAt === null ? 0 : Math.max(0, now - state.joinedAt)
}
