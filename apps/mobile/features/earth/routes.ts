/**
 * Routes of SCREEN 20 (Earth), SCREEN 24–25 (You, Settings) and the destinations they hand off
 * to, spelled once. expo-router groups are transparent in hrefs, so the Earth tab is `/earth`
 * and the You tab `/you` whichever group the shell puts them in. Chats hand off to the map with
 * `/earth?share=<conversationId>` and `/earth?place=<placeId>` (as on the web); You opens
 * `/earth?you=1`. Other agents own `/rooms/[id]`, `/chats/[id]/info`, `/p/[id]`, `/u/[handle]`
 * and `/claim`.
 */
import { DEEP_LINK_PATHS } from '@earth/domain'

export interface HrefObject {
  readonly pathname: string
  readonly params: Readonly<Record<string, string>>
}

/** `/earth` — SCREEN 20 (the Earth tab). */
export const EARTH_ROUTE = '/earth' as const
/** `/you` — SCREEN 24 (the You tab). */
export const YOU_ROUTE = '/you' as const
/** `/home` — where a signed-out person lands. */
export const HOME_ROUTE = '/home' as const
/** `/claim` — where a Visitor claims their place (spec §44). */
export const CLAIM_ROUTE = '/claim' as const
/** `/chats` — SCREEN 08. */
export const CHATS_ROUTE = '/chats' as const

export const EARTH_QUERY = {
  place: 'place',
  share: 'share',
  you: 'you',
} as const

export interface EarthRouteParams {
  readonly placeId?: string
  readonly shareConversationId?: string
  readonly you?: boolean
}

/** `/earth`, `/earth?place=…`, `/earth?share=…`, `/earth?you=1`. */
export function earthHref(params: EarthRouteParams = {}): HrefObject {
  const query: Record<string, string> = {}
  if (params.placeId !== undefined) query[EARTH_QUERY.place] = params.placeId
  if (params.shareConversationId !== undefined)
    query[EARTH_QUERY.share] = params.shareConversationId
  if (params.you === true) query[EARTH_QUERY.you] = '1'
  return { pathname: EARTH_ROUTE, params: query }
}

/** SCREEN 25 routes. */
export const YOU_ROUTES = {
  you: YOU_ROUTE,
  settings: `${YOU_ROUTE}/settings`,
  account: `${YOU_ROUTE}/settings/account`,
  privacy: `${YOU_ROUTE}/settings/privacy`,
  notifications: `${YOU_ROUTE}/settings/notifications`,
  safety: `${YOU_ROUTE}/settings/safety`,
  identity: `${YOU_ROUTE}/settings/identity`,
} as const

export type YouRoute = (typeof YOU_ROUTES)[keyof typeof YOU_ROUTES]

/** `/rooms/<roomId>` — the active room (SCREEN 14, built by the rooms agent). */
export function roomRoute(roomId: string): string {
  return `/rooms/${encodeURIComponent(roomId)}`
}

/** `/p/<postId>` — a Moment opens its post (spec §112). */
export function momentRoute(postId: string): string {
  return `${DEEP_LINK_PATHS.post}${encodeURIComponent(postId)}`
}

/** `/p/<postId>` — a post of yours (SCREEN 24). */
export const postRoute = momentRoute

/** `/chats/<conversationId>/info` — per-conversation notification prefs live on SCREEN 12. */
export function conversationInfoRoute(conversationId: string): string {
  return `${CHATS_ROUTE}/${encodeURIComponent(conversationId)}/info`
}

/** The first value of an expo-router search param (arrays come from repeated keys). */
export function firstParam(value: string | readonly string[] | undefined): string | null {
  if (Array.isArray(value)) return (value[0] as string | undefined) ?? null
  return typeof value === 'string' && value.length > 0 ? value : null
}
