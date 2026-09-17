/**
 * Push decisions (spec §12, §85–§87; ARCHITECTURE §11), pure so the wiring in `lib/push.ts` and
 * `components/shell/PushRegistrar.tsx` stays thin:
 *
 * - permission is asked at the first meaningful moment — after a claim completes, on first Live,
 *   room or Notifications interest — never on app open, never of a Visitor or Guest;
 * - a permission already granted registers the Expo token silently and re-sends it when the token
 *   or the Human changes; a refusal is respected for the rest of the process;
 * - Android channels follow the server's families (`packages/server/src/push/messages.ts`):
 *   `messages`, `live` (high importance), `social`;
 * - a push that arrives in the foreground becomes one quiet in-app line unless it names the
 *   conversation or room the person is already in.
 */
import type { NotificationType, PushPlatform } from '@earth/domain'
import { copy } from '@earth/ui'

import { readPushTarget } from '../deeplinks'
import { ROUTES, conversationRoute, roomRoute } from '../routes'

// ---------------------------------------------------------------------------
// Permission and registration
// ---------------------------------------------------------------------------

/** `unknown` until the OS has been asked what it remembers. */
export const PUSH_PERMISSIONS = ['unknown', 'undetermined', 'granted', 'denied'] as const
export type PushPermission = (typeof PUSH_PERMISSIONS)[number]

/** The meaningful moments that may ask for permission (spec §85). */
export const PUSH_INTEREST_REASONS = ['claim_completed', 'live', 'room', 'notifications'] as const
export type PushInterestReason = (typeof PUSH_INTEREST_REASONS)[number]

export interface PushRegistrationState {
  readonly permission: PushPermission
  /** `human:<id>:<token>` of the last successful registration. */
  readonly registeredKey: string | null
}

export const INITIAL_PUSH_STATE: PushRegistrationState = {
  permission: 'unknown',
  registeredKey: null,
}

export const PUSH_ACTIONS = ['none', 'read_permission', 'request_permission', 'register'] as const
export type PushAction = (typeof PUSH_ACTIONS)[number]

export interface NextPushActionInput {
  readonly humanId: string | null
  readonly isDevice: boolean
  readonly online: boolean
  /** A meaningful moment happened (`PushInterestReason`). */
  readonly interested: boolean
  readonly state: PushRegistrationState
}

/**
 * What to do next: nothing for anyone but a Human on a real, online device; read what the OS
 * remembers first; register silently when it is granted; ask only at a meaningful moment; and
 * never ask again after a refusal.
 */
export function nextPushAction(input: NextPushActionInput): PushAction {
  if (input.humanId === null || !input.isDevice || !input.online) return 'none'
  switch (input.state.permission) {
    case 'unknown':
      return 'read_permission'
    case 'granted':
      return 'register'
    case 'undetermined':
      return input.interested ? 'request_permission' : 'none'
    case 'denied':
      return 'none'
    default: {
      const exhaustive: never = input.state.permission
      throw new Error(`Unknown push permission: ${String(exhaustive)}`)
    }
  }
}

export function registrationKey(humanId: string, token: string): string {
  return `human:${humanId}:${token}`
}

/** Whether a fresh token still needs sending for this Human. */
export function needsRegistration(
  state: PushRegistrationState,
  humanId: string,
  token: string,
): boolean {
  return state.registeredKey !== registrationKey(humanId, token)
}

export function pushPlatformFor(os: string): PushPlatform {
  return os === 'ios' ? 'ios' : 'android'
}

function isWithin(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`)
}

/** The shell's own surfaces that count as interest: the Live tab, a room, Notifications. */
export function interestReasonForPathname(pathname: string): PushInterestReason | null {
  if (isWithin(pathname, ROUTES.live)) return 'live'
  if (pathname.startsWith('/rooms/')) return 'room'
  if (isWithin(pathname, ROUTES.notifications)) return 'notifications'
  return null
}

// ---------------------------------------------------------------------------
// Android channels (mirrors `packages/server/src/push/messages.ts`)
// ---------------------------------------------------------------------------

export const PUSH_CHANNELS = { messages: 'messages', live: 'live', social: 'social' } as const
export type PushChannel = (typeof PUSH_CHANNELS)[keyof typeof PUSH_CHANNELS]

export const CHANNEL_IMPORTANCES = ['low', 'default', 'high'] as const
export type ChannelImportance = (typeof CHANNEL_IMPORTANCES)[number]

export interface PushChannelSpec {
  readonly id: PushChannel
  /** Shown in the system's notification settings; the spec's own words (SCREEN 25). */
  readonly name: string
  readonly importance: ChannelImportance
  readonly sound: boolean
}

const CHANNEL_NAMES = copy.settings.sections.notifications.items

/** Live is the one family that may interrupt (spec §85–§87); social never makes a sound. */
export const PUSH_CHANNEL_SPECS: readonly PushChannelSpec[] = [
  { id: PUSH_CHANNELS.messages, name: CHANNEL_NAMES.messages, importance: 'default', sound: true },
  { id: PUSH_CHANNELS.live, name: CHANNEL_NAMES.live, importance: 'high', sound: true },
  { id: PUSH_CHANNELS.social, name: CHANNEL_NAMES.social, importance: 'low', sound: false },
]

export function pushChannelFor(type: NotificationType): PushChannel {
  switch (type) {
    case 'friend_live':
    case 'multi_live':
    case 'group_live':
      return PUSH_CHANNELS.live
    case 'direct_message':
    case 'group_message':
      return PUSH_CHANNELS.messages
    case 'friend_request':
    case 'friend_accepted':
    case 'follow':
    case 'group_invitation':
      return PUSH_CHANNELS.social
    default: {
      const exhaustive: never = type
      throw new Error(`Unknown notification type: ${String(exhaustive)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Foreground
// ---------------------------------------------------------------------------

/**
 * Whether a push that arrived while the app is open should be shown at all: not when it names
 * the conversation (or its info screen) or the room the person is already in.
 */
export function shouldPresentInForeground(data: unknown, pathname: string): boolean {
  const target = readPushTarget(data)
  if (
    target.conversationId !== null &&
    isWithin(pathname, conversationRoute(target.conversationId))
  ) {
    return false
  }
  if (target.roomId !== null && isWithin(pathname, roomRoute(target.roomId))) return false
  return true
}

/** `Xavier is live — Cooking dinner` (spec §86 title + body); `null` when there is nothing to say. */
export function foregroundLine(
  title: string | null | undefined,
  body: string | null | undefined,
): string | null {
  const line = copy.notificationLine({ title: title ?? '', body: body ?? '' })
  return line.length === 0 ? null : line
}
