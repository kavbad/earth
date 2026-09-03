/**
 * SCREEN 15 option derivation: which visibilities and "Who can join" policies the Open up sheet
 * offers for a room, given its context and the feature flags (spec §118). Labels come from
 * `@earth/ui`, sentences from `@earth/domain`'s `describeVisibility` (the shared rule home).
 */
import { FeatureFlag, type FeatureFlags } from '@earth/config'
import {
  type RoomContextType,
  type RoomJoinPolicy,
  type RoomVisibility,
  allowedJoinPoliciesFor,
  describeVisibility,
  openUpOptionsFor,
} from '@earth/domain'
import { OPEN_UP_JOIN_POLICY_OPTIONS, copy } from '@earth/ui'

import { roomCopy } from '../copy'

export interface OpenUpVisibilityOption {
  readonly visibility: RoomVisibility
  readonly label: string
  readonly description: string
}

export interface OpenUpJoinPolicyOption {
  readonly joinPolicy: RoomJoinPolicy
  readonly label: string
  readonly description: string
}

/** Whether the flags let a room open up to `visibility` (spec §118; ARCHITECTURE §12). */
export function isVisibilityEnabled(visibility: RoomVisibility, flags: FeatureFlags): boolean {
  switch (visibility) {
    case 'invited':
    case 'group':
      return true
    case 'friends':
    case 'extended':
      return flags[FeatureFlag.FRIENDS_LIVE_EXPANSION_ENABLED]
    case 'neighborhood':
      return flags[FeatureFlag.PUBLIC_LIVE_ENABLED] && flags[FeatureFlag.NEIGHBORHOOD_ENABLED]
    case 'city':
      return flags[FeatureFlag.PUBLIC_LIVE_ENABLED] && flags[FeatureFlag.CITY_ENABLED]
    case 'world':
      return (
        flags[FeatureFlag.PUBLIC_LIVE_ENABLED] &&
        flags[FeatureFlag.WORLD_ENABLED] &&
        flags[FeatureFlag.WORLD_LIVE_EXPANSION_ENABLED]
      )
  }
}

/**
 * Visibility choices in the sheet's order — Just us / Group, Friends, Neighborhood, City, World —
 * narrowed by context (`group` only for group rooms, `invited` otherwise) and by flags. The
 * room's current visibility is always offered so the sheet can show where the room is now.
 */
export function openUpVisibilityOptions(
  contextType: RoomContextType,
  flags: FeatureFlags,
  current: RoomVisibility,
): OpenUpVisibilityOption[] {
  const offered = openUpOptionsFor(contextType).filter(
    (visibility) => visibility === current || isVisibilityEnabled(visibility, flags),
  )
  const withCurrent = offered.includes(current) ? offered : [current, ...offered]
  return withCurrent.map((visibility) => ({
    visibility,
    label: copy.visibility[visibility],
    description: describeVisibility(visibility).description,
  }))
}

/**
 * "Who can join" choices for a visibility, in the sheet's order (Invite only, Group, Friends,
 * Request, Anyone eligible), restricted to the pairs the domain allows for it.
 */
export function openUpJoinPolicyOptions(
  visibility: RoomVisibility,
  contextType: RoomContextType,
): OpenUpJoinPolicyOption[] {
  const allowed = allowedJoinPoliciesFor(visibility, contextType)
  return OPEN_UP_JOIN_POLICY_OPTIONS.filter((policy) => allowed.includes(policy)).map(
    (joinPolicy) => ({
      joinPolicy,
      label: copy.joinPolicies[joinPolicy],
      description: roomCopy.joinPolicyDescriptions[joinPolicy],
    }),
  )
}

/**
 * The join policy to preselect when the visibility changes: the room's current one if it is still
 * offered, else the domain's default for the visibility (first allowed), else the first offered.
 */
export function defaultJoinPolicyFor(
  visibility: RoomVisibility,
  contextType: RoomContextType,
  current: RoomJoinPolicy,
): RoomJoinPolicy {
  const options = openUpJoinPolicyOptions(visibility, contextType).map((o) => o.joinPolicy)
  if (options.includes(current)) return current
  const domainDefault = allowedJoinPoliciesFor(visibility, contextType)[0]
  if (domainDefault !== undefined && options.includes(domainDefault)) return domainDefault
  return options[0] ?? current
}

export interface OpenUpFormState {
  readonly visibility: RoomVisibility
  readonly joinPolicy: RoomJoinPolicy
}

export type OpenUpFormAction =
  | { readonly type: 'visibility'; readonly visibility: RoomVisibility }
  | { readonly type: 'joinPolicy'; readonly joinPolicy: RoomJoinPolicy }

/** Sheet form state: changing the visibility re-derives the join policy it offers. */
export function openUpFormReducer(
  contextType: RoomContextType,
): (state: OpenUpFormState, action: OpenUpFormAction) => OpenUpFormState {
  return (state, action) => {
    switch (action.type) {
      case 'visibility':
        return {
          visibility: action.visibility,
          joinPolicy: defaultJoinPolicyFor(action.visibility, contextType, state.joinPolicy),
        }
      case 'joinPolicy':
        return { ...state, joinPolicy: action.joinPolicy }
    }
  }
}
