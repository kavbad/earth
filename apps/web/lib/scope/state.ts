/**
 * The universal social-radius control's state (spec §51–§52): one scope per surface (Home, Live,
 * Earth), remembered per Human (`scope_set`) with a local cache, and per device for Visitors.
 * Defaults: Friends after membership, World for Visitors. Which scopes a person may open depends
 * on their state and the feature flags (spec §118): a Visitor tapping Friends / Neighborhood /
 * City meets the claim sheet (SCREEN 01), a disabled flag hides nothing but disables the label.
 */
import { FeatureFlag, type FeatureFlags } from '@earth/config'
import { SCOPES, type RoleKind, type Scope, ScopeSchema } from '@earth/domain'

import { type KeyValueStorage, readString, writeString } from '../storage'

export const SCOPE_SURFACES = ['home', 'live', 'earth'] as const
export type ScopeSurface = (typeof SCOPE_SURFACES)[number]

export type ScopeMap = Readonly<Record<ScopeSurface, Scope>>

export const SCOPE_STORAGE_PREFIX = 'earth.scope' as const

export function defaultScopeFor(roleKind: RoleKind): Scope {
  return roleKind === 'human' ? 'friends' : 'world'
}

/** `earth.scope.home` for Visitors; `earth.scope.<humanId>.home` for a Human on this device. */
export function scopeStorageKey(surface: ScopeSurface, humanId: string | null): string {
  return humanId === null
    ? `${SCOPE_STORAGE_PREFIX}.${surface}`
    : `${SCOPE_STORAGE_PREFIX}.${humanId}.${surface}`
}

export type ScopeAvailability = 'available' | 'claim' | 'disabled'

export interface ScopeAvailabilityContext {
  readonly roleKind: RoleKind
  readonly flags: FeatureFlags
}

/**
 * `available` opens the scope; `claim` means the person is not a Human yet (the claim sheet is
 * shown instead); `disabled` means the flag turned the radius off for everyone.
 */
export function scopeAvailability(
  scope: Scope,
  context: ScopeAvailabilityContext,
): ScopeAvailability {
  const human = context.roleKind === 'human'
  switch (scope) {
    case 'friends':
      return human ? 'available' : 'claim'
    case 'neighborhood':
      if (!context.flags[FeatureFlag.NEIGHBORHOOD_ENABLED]) return 'disabled'
      return human ? 'available' : 'claim'
    case 'city':
      if (!context.flags[FeatureFlag.CITY_ENABLED]) return 'disabled'
      return human ? 'available' : 'claim'
    case 'world':
      if (human) return context.flags[FeatureFlag.WORLD_ENABLED] ? 'available' : 'disabled'
      return context.flags[FeatureFlag.PUBLIC_WORLD_ENABLED] ? 'available' : 'disabled'
    default: {
      const exhaustive: never = scope
      throw new Error(`Unknown scope: ${String(exhaustive)}`)
    }
  }
}

export function availabilityByScope(
  context: ScopeAvailabilityContext,
): Readonly<Record<Scope, ScopeAvailability>> {
  const out = {} as Record<Scope, ScopeAvailability>
  for (const scope of SCOPES) out[scope] = scopeAvailability(scope, context)
  return out
}

export interface InitialScopesInput {
  readonly roleKind: RoleKind
  readonly humanId: string | null
  readonly storage: KeyValueStorage | null
  readonly flags: FeatureFlags
}

/** A stored scope is honoured only when it is still available; otherwise the default applies. */
export function initialScopes(input: InitialScopesInput): ScopeMap {
  const fallback = defaultScopeFor(input.roleKind)
  const context = { roleKind: input.roleKind, flags: input.flags }
  const out = {} as Record<ScopeSurface, Scope>
  for (const surface of SCOPE_SURFACES) {
    const stored = ScopeSchema.safeParse(
      readString(input.storage, scopeStorageKey(surface, input.humanId)),
    )
    const candidate = stored.success ? stored.data : fallback
    out[surface] =
      scopeAvailability(candidate, context) === 'available'
        ? candidate
        : scopeAvailability(fallback, context) === 'available'
          ? fallback
          : 'world'
  }
  return out
}

export type ScopeAction =
  | { readonly type: 'set'; readonly surface: ScopeSurface; readonly scope: Scope }
  | { readonly type: 'reset'; readonly scopes: ScopeMap }

export function scopeReducer(state: ScopeMap, action: ScopeAction): ScopeMap {
  switch (action.type) {
    case 'set':
      return state[action.surface] === action.scope
        ? state
        : { ...state, [action.surface]: action.scope }
    case 'reset':
      return action.scopes
    default: {
      const exhaustive: never = action
      throw new Error(`Unknown scope action: ${String(exhaustive)}`)
    }
  }
}

export function rememberScope(
  storage: KeyValueStorage | null,
  surface: ScopeSurface,
  humanId: string | null,
  scope: Scope,
): void {
  writeString(storage, scopeStorageKey(surface, humanId), scope)
}
