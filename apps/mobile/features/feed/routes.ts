/**
 * Routes of the Home, post, profile, notifications and search screens (SCREEN 01–07, 21–23;
 * spec §112 `/p/:postId`, `/@handle`) and the destinations they hand off to, spelled once.
 * expo-router groups are transparent in hrefs, so Home is `/home` whichever group the shell puts
 * it in. Other agents own `/chats/[id]`, `/rooms/[id]`, `/earth` and `/claim`; the public
 * `/@handle` link lands on `/u/[handle]` (a folder cannot be named `@[handle]`).
 */
import { type Audience, AudienceSchema, DEEP_LINK_PATHS, postUrl, profileUrl } from '@earth/domain'

export interface HrefObject {
  readonly pathname: string
  readonly params: Readonly<Record<string, string>>
}

/** `/home` — SCREEN 01–05 (the Home tab). */
export const HOME_ROUTE = '/home' as const
/** `/compose` — SCREEN 06. */
export const COMPOSE_ROUTE = '/compose' as const
/** `/notifications` — SCREEN 23. */
export const NOTIFICATIONS_ROUTE = '/notifications' as const
/** `/search` — SCREEN 21. */
export const SEARCH_ROUTE = '/search' as const
/** `/you` — SCREEN 24 (the You tab; "Edit profile" lands there). */
export const YOU_ROUTE = '/you' as const
/** `/claim` — where a Visitor claims their place (spec §44). */
export const CLAIM_ROUTE = '/claim' as const
/** `/earth` — SCREEN 20. */
export const EARTH_ROUTE = '/earth' as const
/** `/chats` — SCREEN 08. */
export const CHATS_ROUTE = '/chats' as const
/** Where `/@handle` is implemented. */
export const PROFILE_IMPLEMENTATION_PATH = '/u' as const

/** `?q=` preselects a search (SCREEN 21). */
export const SEARCH_QUERY_PARAM = 'q' as const
/** `?replyTo=<postId>` opens the composer as a reply capped by the root audience (spec §72). */
export const REPLY_TO_QUERY = 'replyTo' as const
/** `?audience=<audience>` presets the audience (the Home radius the person came from). */
export const AUDIENCE_QUERY = 'audience' as const

/** `maya` · `@Maya ` → `maya`: the bare, lowercase handle. */
export function bareHandle(handle: string): string {
  return handle.trim().replace(/^@+/, '').toLowerCase()
}

/** `/p/<postId>` — SCREEN 07 and the public link. */
export function postRoute(postId: string): string {
  return `${DEEP_LINK_PATHS.post}${encodeURIComponent(postId)}`
}

/** `/u/<handle>` — SCREEN 22 (the `/@handle` deep link lands here). */
export function profileRoute(handle: string): string {
  return `${PROFILE_IMPLEMENTATION_PATH}/${encodeURIComponent(bareHandle(handle))}`
}

export interface ComposeRouteOptions {
  readonly replyTo?: string
  readonly audience?: Audience
}

/** `/compose`, `/compose?replyTo=…`, `/compose?audience=…`. */
export function composeHref(options: ComposeRouteOptions = {}): HrefObject {
  const params: Record<string, string> = {}
  if (options.replyTo !== undefined) params[REPLY_TO_QUERY] = options.replyTo
  if (options.audience !== undefined) params[AUDIENCE_QUERY] = options.audience
  return { pathname: COMPOSE_ROUTE, params }
}

/** `/search` or `/search?q=<query>`. */
export function searchHref(query?: string): HrefObject {
  const q = query?.trim() ?? ''
  return { pathname: SEARCH_ROUTE, params: q.length === 0 ? {} : { [SEARCH_QUERY_PARAM]: q } }
}

/** `/chats/<conversationId>` — SCREEN 10/11 (built by the chats agent). */
export function conversationRoute(conversationId: string): string {
  return `${CHATS_ROUTE}/${encodeURIComponent(conversationId)}`
}

/** `/rooms/<roomId>` — the active room (SCREEN 14, built by the rooms agent). */
export function roomRoute(roomId: string): string {
  return `/rooms/${encodeURIComponent(roomId)}`
}

/** `/earth?place=<placeId>` — a tagged place on the map (SCREEN 20). */
export function earthPlaceHref(placeId: string): HrefObject {
  return { pathname: EARTH_ROUTE, params: { place: placeId } }
}

/** The audience preset carried by `?audience=`, or `null` when absent or not an audience. */
export function audienceFromQuery(value: string | string[] | null | undefined): Audience | null {
  const single = Array.isArray(value) ? value[0] : value
  const parsed = AudienceSchema.safeParse(single)
  return parsed.success ? parsed.data : null
}

/** The first value of an expo-router param (`string | string[] | undefined`). */
export function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/** `https://earth.social/p/<postId>` — what "Share" hands to the share sheet (spec §112). */
export function postShareUrl(origin: string, postId: string): string {
  return postUrl(origin, postId)
}

/** `https://earth.social/@handle`. */
export function profileShareUrl(origin: string, handle: string): string {
  return profileUrl(origin, bareHandle(handle))
}
