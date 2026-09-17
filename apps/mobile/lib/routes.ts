/**
 * Every route the shell owns, spelled once (spec §50 navigation, §44–§49 claim, §112 deep links).
 * Feature agents keep their own route helpers next to their screens; these are the shell's
 * destinations (tabs, claim, welcome, the deep-link entries) and the tab that owns a pathname.
 */
import { DEEP_LINK_PATHS } from '@earth/domain'
import { TABS, type Tab } from '@earth/ui'

export const ROUTES = {
  root: '/',
  home: '/home',
  chats: '/chats',
  live: '/live',
  earth: '/earth',
  you: '/you',
  notifications: '/notifications',
  claim: '/claim',
  claimStart: '/claim/start',
  claimJoin: '/claim/join',
  claimCredential: '/claim/credential',
  claimIdentity: '/claim/identity',
  claimHuman: '/claim/human',
  welcome: '/welcome',
} as const

export type StaticRoute = (typeof ROUTES)[keyof typeof ROUTES]

export interface HrefObject {
  readonly pathname: string
  readonly params: Readonly<Record<string, string>>
}

/** Bottom navigation destination per tab (spec §50), in tab order. */
export const TAB_ROUTES: Readonly<Record<Tab, StaticRoute>> = {
  home: ROUTES.home,
  chats: ROUTES.chats,
  live: ROUTES.live,
  earth: ROUTES.earth,
  you: ROUTES.you,
}

/** Where `/@handle` is implemented (a folder cannot be named `@[handle]`). */
export const PROFILE_IMPLEMENTATION_PATH = '/u' as const

/** `/chats/<conversationId>` — the conversation screens (SCREEN 10/11). */
export function conversationRoute(conversationId: string): string {
  return `${ROUTES.chats}/${encodeURIComponent(conversationId)}`
}

/** `/rooms/<roomId>` — the active room (SCREEN 14). */
export function roomRoute(roomId: string): string {
  return `/rooms/${encodeURIComponent(roomId)}`
}

/** `/u/<handle>` — a profile (SCREEN 22; the `/@handle` deep link lands here). */
export function profileRoute(handle: string): string {
  return `${PROFILE_IMPLEMENTATION_PATH}/${encodeURIComponent(handle.replace(/^@+/, '').toLowerCase())}`
}

/** `/p/<postId>` — a post (SCREEN 07 and the public link). */
export function postRoute(postId: string): string {
  return `${DEEP_LINK_PATHS.post}${encodeURIComponent(postId)}`
}

/** `/g/<token>` — the group invite deep link (spec §112). */
export function groupInviteRoute(token: string): string {
  return `${DEEP_LINK_PATHS.groupInvite}${encodeURIComponent(token)}`
}

/** `/live/<token>` — the room invite deep link (spec §112). */
export function roomInviteRoute(token: string): string {
  return `${DEEP_LINK_PATHS.roomInvite}${encodeURIComponent(token)}`
}

/** `/claim/join?token=<token>` — the join-group claim flow entry (spec §46). */
export function claimJoinHref(token: string): HrefObject {
  return { pathname: ROUTES.claimJoin, params: { token } }
}

/** The tab whose destination owns `pathname` (`/chats/abc` → `chats`), or `null` outside the shell. */
export function tabForPathname(pathname: string): Tab | null {
  for (const tab of TABS) {
    const base: string = TAB_ROUTES[tab]
    if (pathname === base || pathname.startsWith(`${base}/`)) return tab
  }
  return null
}

/** The first value of an expo-router search param (arrays come from repeated keys). */
export function firstParam(value: string | readonly string[] | undefined): string | null {
  if (Array.isArray(value)) return (value[0] as string | undefined) ?? null
  return typeof value === 'string' && value.length > 0 ? value : null
}
