/**
 * Device preferences until a server preference exists (SCREEN 25 Privacy and Notifications): the
 * default post audience, the Live defaults and the four notification categories (spec §86).
 * Pure over `KeyValueStorage`; values are validated with the domain enums so a stale or
 * hand-edited value never leaks into a composer or an Open up sheet.
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
import { z } from 'zod'

import { type KeyValueStorage, readJson, readString, writeJson, writeString } from '../storage'

export const PREFS_STORAGE_PREFIX = 'earth.prefs' as const

export const PREF_NAMES = [
  'defaultAudience',
  'liveVisibility',
  'liveJoinPolicy',
  'notificationCategories',
] as const
export type PrefName = (typeof PREF_NAMES)[number]

export function prefKey(humanId: string, name: PrefName): string {
  return `${PREFS_STORAGE_PREFIX}.${humanId}.${name}`
}

// ---------------------------------------------------------------------------
// Default post audience
// ---------------------------------------------------------------------------

/** Spec §51: after membership everything starts with Friends. */
export const DEFAULT_AUDIENCE: Audience = 'friends'

export function parseAudience(value: string | null): Audience {
  const parsed = AudienceSchema.safeParse(value)
  return parsed.success ? parsed.data : DEFAULT_AUDIENCE
}

export async function readDefaultAudience(
  storage: KeyValueStorage | null,
  humanId: string,
): Promise<Audience> {
  return parseAudience(await readString(storage, prefKey(humanId, 'defaultAudience')))
}

export function writeDefaultAudience(
  storage: KeyValueStorage | null,
  humanId: string,
  audience: Audience,
): Promise<void> {
  return writeString(storage, prefKey(humanId, 'defaultAudience'), audience)
}

// ---------------------------------------------------------------------------
// Live defaults
// ---------------------------------------------------------------------------

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

export function parseLiveDefaults(
  visibility: string | null,
  joinPolicy: string | null,
): LiveDefaults {
  const v = RoomVisibilitySchema.safeParse(visibility)
  const j = RoomJoinPolicySchema.safeParse(joinPolicy)
  return {
    visibility:
      v.success && LIVE_VISIBILITY_CHOICES.includes(v.data)
        ? v.data
        : LIVE_DEFAULTS_FALLBACK.visibility,
    joinPolicy:
      j.success && LIVE_JOIN_POLICY_CHOICES.includes(j.data)
        ? j.data
        : LIVE_DEFAULTS_FALLBACK.joinPolicy,
  }
}

export async function readLiveDefaults(
  storage: KeyValueStorage | null,
  humanId: string,
): Promise<LiveDefaults> {
  const [visibility, joinPolicy] = await Promise.all([
    readString(storage, prefKey(humanId, 'liveVisibility')),
    readString(storage, prefKey(humanId, 'liveJoinPolicy')),
  ])
  return parseLiveDefaults(visibility, joinPolicy)
}

export async function writeLiveDefaults(
  storage: KeyValueStorage | null,
  humanId: string,
  defaults: LiveDefaults,
): Promise<void> {
  await Promise.all([
    writeString(storage, prefKey(humanId, 'liveVisibility'), defaults.visibility),
    writeString(storage, prefKey(humanId, 'liveJoinPolicy'), defaults.joinPolicy),
  ])
}

// ---------------------------------------------------------------------------
// Notification categories (spec §86: messages, Live, social, engagement)
// ---------------------------------------------------------------------------

export const NOTIFICATION_CATEGORIES = ['messages', 'live', 'social', 'engagement'] as const
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

export type NotificationCategoryPrefs = Readonly<Record<NotificationCategory, boolean>>

/** Everything on; engagement is the quiet one people turn off first, but it starts on too. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationCategoryPrefs = {
  messages: true,
  live: true,
  social: true,
  engagement: true,
}

const NotificationCategoryPrefsSchema = z.object({
  messages: z.boolean(),
  live: z.boolean(),
  social: z.boolean(),
  engagement: z.boolean(),
})

/** Unknown keys are dropped, missing ones default on; anything malformed reads as the default. */
export function parseNotificationPrefs(value: unknown): NotificationCategoryPrefs {
  const parsed = NotificationCategoryPrefsSchema.partial().safeParse(value)
  if (!parsed.success) return DEFAULT_NOTIFICATION_PREFS
  const out: Record<NotificationCategory, boolean> = { ...DEFAULT_NOTIFICATION_PREFS }
  for (const category of NOTIFICATION_CATEGORIES) {
    const stored = parsed.data[category]
    if (typeof stored === 'boolean') out[category] = stored
  }
  return out
}

export type NotificationPrefsAction =
  | { readonly type: 'toggle'; readonly category: NotificationCategory }
  | { readonly type: 'set'; readonly category: NotificationCategory; readonly enabled: boolean }
  | { readonly type: 'replace'; readonly prefs: NotificationCategoryPrefs }

export function notificationPrefsReducer(
  state: NotificationCategoryPrefs,
  action: NotificationPrefsAction,
): NotificationCategoryPrefs {
  switch (action.type) {
    case 'toggle':
      return { ...state, [action.category]: !state[action.category] }
    case 'set':
      return state[action.category] === action.enabled
        ? state
        : { ...state, [action.category]: action.enabled }
    case 'replace':
      return action.prefs
    default: {
      const exhaustive: never = action
      throw new Error(`Unknown notification prefs action: ${String(exhaustive)}`)
    }
  }
}

export async function readNotificationPrefs(
  storage: KeyValueStorage | null,
  humanId: string,
): Promise<NotificationCategoryPrefs> {
  const stored = await readJson(storage, prefKey(humanId, 'notificationCategories'), (value) =>
    parseNotificationPrefs(value),
  )
  return stored ?? DEFAULT_NOTIFICATION_PREFS
}

export function writeNotificationPrefs(
  storage: KeyValueStorage | null,
  humanId: string,
  prefs: NotificationCategoryPrefs,
): Promise<void> {
  return writeJson(storage, prefKey(humanId, 'notificationCategories'), prefs)
}

// ---------------------------------------------------------------------------
// Push permission (expo-notifications) as the screen shows it
// ---------------------------------------------------------------------------

export type PushPermissionState = 'unknown' | 'undetermined' | 'granted' | 'denied' | 'blocked'

/** From a permission response (`status`, `granted`, `canAskAgain`) to what the row says. */
export function pushPermissionState(
  response: {
    readonly status: string
    readonly granted: boolean
    readonly canAskAgain?: boolean
  } | null,
): PushPermissionState {
  if (response === null) return 'unknown'
  if (response.granted) return 'granted'
  if (response.status === 'undetermined') return 'undetermined'
  return response.canAskAgain === false ? 'blocked' : 'denied'
}

/** Whether the row offers "Allow notifications" (ask) or "Open Settings" (the system will not ask). */
export function pushPermissionAction(state: PushPermissionState): 'ask' | 'settings' | 'none' {
  switch (state) {
    case 'undetermined':
    case 'denied':
      return 'ask'
    case 'blocked':
      return 'settings'
    case 'granted':
    case 'unknown':
      return 'none'
    default: {
      const exhaustive: never = state
      throw new Error(`Unknown push permission state: ${String(exhaustive)}`)
    }
  }
}
