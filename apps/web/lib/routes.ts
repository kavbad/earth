/**
 * Every route of the web client in one place (spec §50 navigation, §44–§49 claim, §112 deep
 * links). Typed routes are on (`next.config.ts`), so dynamic paths are built here and cast once;
 * screens never spell a path as a string literal.
 */
import { DEEP_LINK_PATHS } from '@earth/domain'
import { TABS, type Tab } from '@earth/ui'
import type { Route } from 'next'

export const ROUTES = {
  root: '/',
  home: '/home',
  chats: '/chats',
  live: '/live',
  earth: '/earth',
  you: '/you',
  claim: '/claim',
  claimStart: '/claim/start',
  claimJoin: '/claim/join',
  claimCredential: '/claim/credential',
  claimIdentity: '/claim/identity',
  claimHuman: '/claim/human',
  welcome: '/welcome',
  authCallback: '/auth/callback',
  signOut: '/auth/signout',
} as const

export type StaticRoute = (typeof ROUTES)[keyof typeof ROUTES]

/** Bottom navigation destination per tab (spec §50), in tab order. */
/**
 * Paths become `Route` here and nowhere else: the four tab destinations other agents build
 * (`/chats`, `/live`, `/earth`, `/you`) are not known to typed routes until their pages exist.
 */
export function asRoute(path: StaticRoute | (string & {})): Route {
  return path as Route
}

export const TAB_ROUTES: Readonly<Record<Tab, Route>> = {
  home: asRoute(ROUTES.home),
  chats: asRoute(ROUTES.chats),
  live: asRoute(ROUTES.live),
  earth: asRoute(ROUTES.earth),
  you: asRoute(ROUTES.you),
}

/** `/chats/<conversationId>` — the conversation screens (SCREEN 10/11). */
export function conversationRoute(conversationId: string): Route {
  return asRoute(`${ROUTES.chats}/${encodeURIComponent(conversationId)}`)
}

/** `/g/<token>` — the group invite deep link (spec §112). */
export function groupInviteRoute(token: string): Route {
  return asRoute(`${DEEP_LINK_PATHS.groupInvite}${encodeURIComponent(token)}`)
}

/** `/claim/join?token=<token>` — the join-group claim flow entry (spec §46). */
export function claimJoinRoute(token: string): Route {
  return asRoute(`${ROUTES.claimJoin}?token=${encodeURIComponent(token)}`)
}

/** `/auth/callback?next=<path>` — where an OTP link lands. */
export function authCallbackRoute(next: string): Route {
  return asRoute(`${ROUTES.authCallback}?next=${encodeURIComponent(next)}`)
}

/** The tab whose destination owns `pathname` (`/chats/abc` → `chats`), or `null` outside the shell. */
export function tabForPathname(pathname: string): Tab | null {
  for (const tab of TABS) {
    const base: string = TAB_ROUTES[tab]
    if (pathname === base || pathname.startsWith(`${base}/`)) return tab
  }
  return null
}

/** Only same-origin absolute paths are followed after auth (never `//evil` or a full URL). */
export function safeNextPath(candidate: string | null | undefined, fallback: Route): Route {
  if (candidate === null || candidate === undefined) return fallback
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) {
    return fallback
  }
  return asRoute(candidate)
}
