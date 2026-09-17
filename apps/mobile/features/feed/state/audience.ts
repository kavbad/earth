/**
 * Composer audience logic (SCREEN 06; spec §72): which audiences are offered (capped by the root
 * for replies), which one is selected first (the Home radius the person came from, else what they
 * usually post to), and when choosing one deserves the stronger — not scary — confirmation:
 * only when moving materially outward from the usual audience, and only once per composer.
 * Pure; the device store is read and written by the hooks.
 */
import {
  AUDIENCE,
  type Audience,
  AudienceSchema,
  audienceRank,
  isAudienceWithin,
  isWidening,
  narrowerOf,
} from '@earth/domain'

export const LAST_AUDIENCE_STORAGE_PREFIX = 'earth.compose.audience' as const

/** The member default (spec §51: Friends after membership). */
export const MEMBER_DEFAULT_AUDIENCE: Audience = 'friends'

/** Widening by this many steps is "material" even when the target is not World. */
export const MATERIAL_WIDENING_STEPS = 2

export function lastAudienceStorageKey(humanId: string): string {
  return `${LAST_AUDIENCE_STORAGE_PREFIX}.${humanId}`
}

/** The stored value parsed as an audience, or `null` when absent or malformed. */
export function parseLastAudience(raw: string | null): Audience | null {
  const parsed = AudienceSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** Audiences the composer offers, narrow → wide, never beyond the root's (replies, spec §72). */
export function audienceOptions(cap: Audience | null): readonly Audience[] {
  return cap === null ? AUDIENCE : AUDIENCE.filter((audience) => isAudienceWithin(audience, cap))
}

export interface DefaultAudienceInput {
  /** `?audience=` preset or the Home radius the composer was opened from. */
  readonly requested: Audience | null
  /** What the Human last posted to on this device. */
  readonly last: Audience | null
  /** The root post's audience when replying. */
  readonly cap: Audience | null
}

/** Requested radius first (SCREEN 06 "default audience: current Home radius"), then usual, then Friends — narrowed to the cap. */
export function defaultAudience(input: DefaultAudienceInput): Audience {
  const preferred = input.requested ?? input.last ?? MEMBER_DEFAULT_AUDIENCE
  return input.cap === null ? preferred : narrowerOf(preferred, input.cap)
}

/**
 * "Moving materially outward" (SCREEN 06): any step into World, or two or more steps wider —
 * Friends → City, Friends → World, Neighborhood → World, City → World. One step into a local
 * radius (Friends → Neighborhood, Neighborhood → City) only needs the visible audience button.
 */
export function isMateriallyOutward(from: Audience, to: Audience): boolean {
  if (!isWidening(from, to)) return false
  if (to === 'world') return true
  return audienceRank(to) - audienceRank(from) >= MATERIAL_WIDENING_STEPS
}

export interface AudienceConfirmationInput {
  readonly chosen: Audience
  /** The usual audience (last used); `null` means the member default. */
  readonly usual: Audience | null
  /** Audiences already confirmed in this composer — never ask twice (spec: not every time). */
  readonly confirmed: readonly Audience[]
}

export function needsAudienceConfirmation(input: AudienceConfirmationInput): boolean {
  if (input.confirmed.includes(input.chosen)) return false
  return isMateriallyOutward(input.usual ?? MEMBER_DEFAULT_AUDIENCE, input.chosen)
}

// ---------------------------------------------------------------------------
// Composer audience reducer
// ---------------------------------------------------------------------------

export interface ComposerAudienceState {
  readonly audience: Audience
  readonly usual: Audience | null
  readonly cap: Audience | null
  readonly confirmed: readonly Audience[]
  /** An audience waiting for the confirmation sheet; `null` when none is open. */
  readonly pending: Audience | null
}

export type ComposerAudienceAction =
  | { readonly type: 'choose'; readonly audience: Audience }
  | { readonly type: 'confirm' }
  | { readonly type: 'cancel' }

export function initialComposerAudience(input: DefaultAudienceInput): ComposerAudienceState {
  return {
    audience: defaultAudience(input),
    usual: input.last,
    cap: input.cap,
    confirmed: [],
    pending: null,
  }
}

export function composerAudienceReducer(
  state: ComposerAudienceState,
  action: ComposerAudienceAction,
): ComposerAudienceState {
  switch (action.type) {
    case 'choose': {
      if (state.cap !== null && !isAudienceWithin(action.audience, state.cap)) return state
      if (action.audience === state.audience) return { ...state, pending: null }
      const ask = needsAudienceConfirmation({
        chosen: action.audience,
        usual: state.usual,
        confirmed: state.confirmed,
      })
      return ask
        ? { ...state, pending: action.audience }
        : { ...state, audience: action.audience, pending: null }
    }
    case 'confirm':
      if (state.pending === null) return state
      return {
        ...state,
        audience: state.pending,
        confirmed: [...state.confirmed, state.pending],
        pending: null,
      }
    case 'cancel':
      return state.pending === null ? state : { ...state, pending: null }
    default: {
      const exhaustive: never = action
      throw new Error(`Unknown audience action: ${String(exhaustive)}`)
    }
  }
}
