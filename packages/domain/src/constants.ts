/**
 * Domain constants shared by the database tier (mirrored in SQL), the server tier and clients.
 */

/** A room with no active Humans is ended by `rooms_sweep()` after this many seconds (ARCHITECTURE §10). */
export const ROOM_GRACE_SECONDS_DEFAULT = 120

/** Guest sessions expire this long after their room ends (spec §34 "short grace period"). */
export const GUEST_SESSION_GRACE_SECONDS = 600

/** A room may push-notify a recipient at most once per this window (ARCHITECTURE §11). */
export const LIVE_NOTIFICATION_COOLDOWN_MINUTES = 30

/** Random bytes behind every invite / guest secret; stored as sha256 hex (ARCHITECTURE §5). */
export const INVITE_TOKEN_BYTES = 32

/** LiveKit token TTL (ARCHITECTURE §10: "Token TTL 2 hours, one token per join"). */
export const MEDIA_GRANT_TTL_SECONDS = 2 * 60 * 60

/** `presence_ping` cadence while foregrounded (ARCHITECTURE §8). */
export const PRESENCE_PING_INTERVAL_SECONDS = 30

/** A Human is "active" for push suppression when pinged within this window (ARCHITECTURE §11). */
export const PRESENCE_ACTIVE_WINDOW_SECONDS = 30

/** Realtime channel join timeout before polling fallback (ARCHITECTURE §8). */
export const REALTIME_JOIN_TIMEOUT_MS = 5_000
export const REALTIME_POLL_INTERVAL_MS = 2_000

/** Handles: 3–24 chars, lowercase letters, digits, underscore; must start with a letter (spec §45). */
export const HANDLE_MIN_LENGTH = 3
export const HANDLE_MAX_LENGTH = 24
export const HANDLE_REGEX = /^[a-z][a-z0-9_]{2,23}$/

export const DISPLAY_NAME_MIN = 1
export const DISPLAY_NAME_MAX = 40
export const BIO_MAX = 280
export const GROUP_NAME_MAX = 60
export const GUEST_DISPLAY_NAME_MAX = 40
export const MESSAGE_TEXT_MAX = 4000
export const POST_TEXT_MAX = 2000
export const REPORT_DETAILS_MAX = 2000
export const SEARCH_QUERY_MAX = 100

export const FEED_PAGE_SIZE = 20
export const MESSAGES_PAGE_SIZE = 50
export const NOTIFICATIONS_PAGE_SIZE = 30
export const SEARCH_SECTION_SIZE = 10
export const GROUP_INVITE_PREVIEW_SAMPLE_SIZE = 3

/** Precise location shares are always bounded (spec §75: "No 'forever' default"). */
export const LOCATION_SHARE_MIN_MINUTES = 15
export const LOCATION_SHARE_MAX_MINUTES = 12 * 60
export const LOCATION_SHARE_DEFAULT_MINUTES = 60

/** Feed cursor format version (ARCHITECTURE §9). */
export const FEED_CURSOR_VERSION = 1

/** Deep link path prefixes (spec §112). */
export const DEEP_LINK_PATHS = {
  groupInvite: '/g/',
  roomInvite: '/live/',
  profile: '/@',
  post: '/p/',
} as const

function joinOrigin(origin: string, path: string): string {
  return origin.replace(/\/+$/, '') + path
}

/** `https://earth.social/g/:groupInviteToken` */
export function groupInviteUrl(origin: string, token: string): string {
  return joinOrigin(origin, `${DEEP_LINK_PATHS.groupInvite}${encodeURIComponent(token)}`)
}

/** `https://earth.social/live/:roomInviteToken` */
export function roomInviteUrl(origin: string, token: string): string {
  return joinOrigin(origin, `${DEEP_LINK_PATHS.roomInvite}${encodeURIComponent(token)}`)
}

/** `https://earth.social/@handle` */
export function profileUrl(origin: string, handle: string): string {
  return joinOrigin(origin, `${DEEP_LINK_PATHS.profile}${encodeURIComponent(handle)}`)
}

/** `https://earth.social/p/:postId` */
export function postUrl(origin: string, postId: string): string {
  return joinOrigin(origin, `${DEEP_LINK_PATHS.post}${encodeURIComponent(postId)}`)
}

export type DeepLink =
  | { kind: 'group_invite'; token: string }
  | { kind: 'room_invite'; token: string }
  | { kind: 'profile'; handle: string }
  | { kind: 'post'; postId: string }

/**
 * Parses a URL path (or a full URL) into a deep link. Returns `null` for anything else.
 * Trailing slashes and query strings are ignored; one path segment only.
 */
export function parseDeepLink(input: string): DeepLink | null {
  let path = input
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(input)
  if (scheme !== null) {
    if (/^https?$/i.test(scheme[1] ?? '')) {
      try {
        path = new URL(input).pathname
      } catch {
        return null
      }
    } else {
      // Custom app scheme (`earth://live/<token>`): the "host" is the first path segment.
      path = `/${input.slice(scheme[0].length)}`
    }
  }
  const clean = path.split(/[?#]/, 1)[0] ?? ''
  const trimmed = clean.replace(/\/+$/, '')
  const match = /^\/(g|live|p)\/([^/]+)$/.exec(trimmed) ?? /^\/(@)([^/]+)$/.exec(trimmed)
  if (match === null) return null
  const prefix = match[1]
  let value: string
  try {
    value = decodeURIComponent(match[2] ?? '')
  } catch {
    return null
  }
  if (value.length === 0) return null
  switch (prefix) {
    case 'g':
      return { kind: 'group_invite', token: value }
    case 'live':
      return { kind: 'room_invite', token: value }
    case 'p':
      return { kind: 'post', postId: value }
    case '@':
      return { kind: 'profile', handle: value }
    default:
      return null
  }
}
