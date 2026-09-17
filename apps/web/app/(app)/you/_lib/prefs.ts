/**
 * Device preferences until a server preference exists (SCREEN 25 Privacy): the default post
 * audience and the Live defaults. Pure over `KeyValueStorage`; values are validated with the
 * domain enums so a stale or hand-edited value never leaks into a composer or an Open up sheet.
 */
import {
  type Audience,
  AudienceSchema,
  type RoomJoinPolicy,
  RoomJoinPolicySchema,
  type RoomVisibility,
  RoomVisibilitySchema,
} from '@earth/domain'
import { OPEN_UP_JOIN_POLICY_OPTIONS, OPEN_UP_VISIBILITY_OPTIONS } from '@earth/ui'

import { type KeyValueStorage, readString, writeString } from '../../../../lib/storage'

export const PREFS_STORAGE_PREFIX = 'earth.prefs' as const

export const PREF_NAMES = ['defaultAudience', 'liveVisibility', 'liveJoinPolicy'] as const
export type PrefName = (typeof PREF_NAMES)[number]

export function prefKey(humanId: string, name: PrefName): string {
  return `${PREFS_STORAGE_PREFIX}.${humanId}.${name}`
}

/** Spec §51: after membership everything starts with Friends. */
export const DEFAULT_AUDIENCE: Audience = 'friends'

export function readDefaultAudience(storage: KeyValueStorage | null, humanId: string): Audience {
  const parsed = AudienceSchema.safeParse(readString(storage, prefKey(humanId, 'defaultAudience')))
  return parsed.success ? parsed.data : DEFAULT_AUDIENCE
}

export function writeDefaultAudience(
  storage: KeyValueStorage | null,
  humanId: string,
  audience: Audience,
): void {
  writeString(storage, prefKey(humanId, 'defaultAudience'), audience)
}

export interface LiveDefaults {
  readonly visibility: RoomVisibility
  readonly joinPolicy: RoomJoinPolicy
}

/** ARCHITECTURE §10: a standalone Live starts `friends` / `friends`. */
export const LIVE_DEFAULTS_FALLBACK: LiveDefaults = { visibility: 'friends', joinPolicy: 'friends' }

/** The Open up choices that make sense as a personal default (a `group` room decides itself). */
export const LIVE_VISIBILITY_CHOICES: readonly RoomVisibility[] = OPEN_UP_VISIBILITY_OPTIONS.filter(
  (option) => option !== 'group',
)
export const LIVE_JOIN_POLICY_CHOICES: readonly RoomJoinPolicy[] =
  OPEN_UP_JOIN_POLICY_OPTIONS.filter((option) => option !== 'group')

export function readLiveDefaults(storage: KeyValueStorage | null, humanId: string): LiveDefaults {
  const visibility = RoomVisibilitySchema.safeParse(
    readString(storage, prefKey(humanId, 'liveVisibility')),
  )
  const joinPolicy = RoomJoinPolicySchema.safeParse(
    readString(storage, prefKey(humanId, 'liveJoinPolicy')),
  )
  return {
    visibility:
      visibility.success && LIVE_VISIBILITY_CHOICES.includes(visibility.data)
        ? visibility.data
        : LIVE_DEFAULTS_FALLBACK.visibility,
    joinPolicy:
      joinPolicy.success && LIVE_JOIN_POLICY_CHOICES.includes(joinPolicy.data)
        ? joinPolicy.data
        : LIVE_DEFAULTS_FALLBACK.joinPolicy,
  }
}

export function writeLiveDefaults(
  storage: KeyValueStorage | null,
  humanId: string,
  defaults: LiveDefaults,
): void {
  writeString(storage, prefKey(humanId, 'liveVisibility'), defaults.visibility)
  writeString(storage, prefKey(humanId, 'liveJoinPolicy'), defaults.joinPolicy)
}
