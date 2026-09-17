/**
 * The deep link contract on a phone (spec §112) — `earth://` and `https://earth.social`:
 * `/g/:token`, `/live/:token` and `/p/:postId` are routes of their own; `/@handle` cannot be a
 * folder, so incoming system URLs are rewritten to `/u/<handle>` before expo-router matches them
 * (`app/+native-intent.tsx`). Push taps carry `PushData` (`packages/server/src/push/messages.ts`)
 * and open the object it names. Pure; `lib/linking.ts` binds this to expo-linking.
 */
import {
  type DeepLink,
  type NotificationType,
  NotificationTypeSchema,
  isUuid,
  parseDeepLink,
} from '@earth/domain'

import {
  PROFILE_IMPLEMENTATION_PATH,
  ROUTES,
  conversationRoute,
  groupInviteRoute,
  postRoute,
  profileRoute,
  roomInviteRoute,
  roomRoute,
} from './routes'

export const APP_SCHEME = 'earth' as const
export const WEB_HOST = 'earth.social' as const
export const CANONICAL_WEB_ORIGIN = `https://${WEB_HOST}` as const

/**
 * Every prefix a link may arrive with: the app scheme, the canonical web origin and — outside
 * production — the configured `WEB_ORIGIN` (a LAN address of the local stack).
 */
export function linkingPrefixes(webOrigin?: string | null): readonly string[] {
  const prefixes: string[] = [`${APP_SCHEME}://`, CANONICAL_WEB_ORIGIN]
  const extra = (webOrigin ?? '').trim().replace(/\/+$/, '')
  if (extra.length > 0 && !prefixes.includes(extra)) prefixes.push(extra)
  return prefixes
}

// ---------------------------------------------------------------------------
// System paths (`+native-intent`)
// ---------------------------------------------------------------------------

/** `scheme://host` (any scheme, possibly an empty host) followed by the path. */
const ABSOLUTE = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(\/.*)?$/i
const HANDLE_PATH = /^\/@([^/?#]+)(.*)$/

function rewritePath(path: string): string {
  const match = HANDLE_PATH.exec(path)
  if (match === null) return path
  const handle = (match[1] ?? '').toLowerCase()
  return `${PROFILE_IMPLEMENTATION_PATH}/${handle}${match[2] ?? ''}`
}

/** `https://earth.social/@Maya` → `https://earth.social/u/maya`; everything else unchanged. */
export function rewriteSystemPath(input: string): string {
  const absolute = ABSOLUTE.exec(input)
  if (absolute !== null) {
    const origin = absolute[1] ?? ''
    const path = absolute[2] ?? ''
    return `${origin}${rewritePath(path)}`
  }
  return rewritePath(input)
}

export interface RedirectSystemPathInput {
  readonly path: string
  readonly initial: boolean
}

/** expo-router's `+native-intent` hook. */
export function redirectSystemPath({ path }: RedirectSystemPathInput): string {
  return rewriteSystemPath(path)
}

// ---------------------------------------------------------------------------
// URLs → routes
// ---------------------------------------------------------------------------

/** The in-app route of a parsed deep link (spec §112). */
export function routeForDeepLink(link: DeepLink): string {
  switch (link.kind) {
    case 'group_invite':
      return groupInviteRoute(link.token)
    case 'room_invite':
      return roomInviteRoute(link.token)
    case 'profile':
      return profileRoute(link.handle)
    case 'post':
      return postRoute(link.postId)
    default: {
      const exhaustive: never = link
      throw new Error(`Unknown deep link: ${String(exhaustive)}`)
    }
  }
}

/** `scheme:///path` (expo-linking's `createURL` form) → `scheme://path`, one host segment. */
function collapseSchemeSlashes(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*):\/\/\/+/i, '$1://')
}

/** `https://earth.social/@Maya` → `/u/maya` · `earth://g/abc` → `/g/abc` · anything else → `null`. */
export function routeForUrl(url: string): string | null {
  const link = parseDeepLink(collapseSchemeSlashes(url.trim()))
  return link === null ? null : routeForDeepLink(link)
}

// ---------------------------------------------------------------------------
// Push data → routes
// ---------------------------------------------------------------------------

/** The fields of `PushData` a tap or a foreground push needs; anything else is ignored. */
export interface PushDataLike {
  readonly type?: unknown
  readonly objectType?: unknown
  readonly objectId?: unknown
  readonly roomId?: unknown
  readonly conversationId?: unknown
  readonly humanId?: unknown
}

export interface PushTarget {
  readonly type: NotificationType | null
  readonly roomId: string | null
  readonly conversationId: string | null
  readonly postId: string | null
  readonly humanId: string | null
}

export const EMPTY_PUSH_TARGET: PushTarget = {
  type: null,
  roomId: null,
  conversationId: null,
  postId: null,
  humanId: null,
}

function uuidField(value: unknown): string | null {
  return typeof value === 'string' && isUuid(value) ? value : null
}

/** Reads what a push points at, tolerating any shape (the data comes off the wire). */
export function readPushTarget(data: unknown): PushTarget {
  if (data === null || typeof data !== 'object') return EMPTY_PUSH_TARGET
  const push = data as PushDataLike
  const type = NotificationTypeSchema.safeParse(push.type)
  const objectId = uuidField(push.objectId)
  const objectOf = (kind: string): string | null => (push.objectType === kind ? objectId : null)
  return {
    type: type.success ? type.data : null,
    roomId: uuidField(push.roomId) ?? objectOf('room'),
    conversationId: uuidField(push.conversationId) ?? objectOf('conversation'),
    postId: objectOf('post'),
    humanId: uuidField(push.humanId) ?? objectOf('human'),
  }
}

/**
 * Where a tapped notification opens: its room (a Live), its conversation (a message, a group
 * invitation), its post, otherwise Notifications — where the social ones (a friend request, a
 * follow) are acted on, since a Human id alone does not name a profile route.
 */
export function routeForPushData(data: unknown): string {
  const target = readPushTarget(data)
  if (target.roomId !== null) return roomRoute(target.roomId)
  if (target.conversationId !== null) return conversationRoute(target.conversationId)
  if (target.postId !== null) return postRoute(target.postId)
  return ROUTES.notifications
}
