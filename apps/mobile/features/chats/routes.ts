/**
 * Routes of the chat screens (SCREEN 08–12) and the destinations they hand off to. The shell
 * spells the shared ones once (`lib/routes.ts`: the Chats tab, a conversation, a room, a
 * profile, the map); this file adds the chats-only paths and the map hand-offs (`place` /
 * `share` params, as on the web). Relative import so the pure modules stay vitest-resolvable.
 */
import {
  type HrefObject,
  ROUTES,
  conversationRoute,
  profileRoute,
  roomRoute,
} from '../../lib/routes'

export type { HrefObject }
export { conversationRoute, profileRoute, roomRoute }

/** `/chats` — SCREEN 08 (the Chats tab). */
export const CHATS_ROUTE = ROUTES.chats

/** `/chats/new` — SCREEN 09. */
export const NEW_CHAT_ROUTE = `${ROUTES.chats}/new` as const

/** `/earth` — SCREEN 20. */
export const EARTH_ROUTE = ROUTES.earth

/** `/chats/<conversationId>/info` — SCREEN 12. */
export function conversationInfoRoute(conversationId: string): string {
  return `${conversationRoute(conversationId)}/info`
}

/** `/earth?place=<placeId>` — a tagged place on the map (SCREEN 20). */
export function earthPlaceHref(placeId: string): HrefObject {
  return { pathname: EARTH_ROUTE, params: { place: placeId } }
}

/** `/earth?share=<conversationId>` — location sharing lives on the map (spec §75). */
export function earthShareHref(conversationId: string): HrefObject {
  return { pathname: EARTH_ROUTE, params: { share: conversationId } }
}
