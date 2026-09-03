/**
 * Routes of the chat screens (SCREEN 08–12) and the destinations they hand off to. Built on the
 * shell's `asRoute` so every path is spelled once; `conversationRoute` itself lives in
 * `lib/routes.ts` because the invite deep link uses it too.
 */
import type { Route } from 'next'

import { ROUTES, asRoute, conversationRoute } from '../../lib/routes'

export { conversationRoute }

/** `/chats/new` — SCREEN 09. */
export const NEW_CHAT_ROUTE: Route = asRoute(`${ROUTES.chats}/new`)

/** `/chats/<conversationId>/info` — SCREEN 12. */
export function conversationInfoRoute(conversationId: string): Route {
  return asRoute(`${ROUTES.chats}/${encodeURIComponent(conversationId)}/info`)
}

/** `/rooms/<roomId>` — the active room (SCREEN 14), built by the rooms agent. */
export function roomRoute(roomId: string): Route {
  return asRoute(`/rooms/${encodeURIComponent(roomId)}`)
}

/** `/@handle` — a profile (spec §112). */
export function profileRoute(handle: string): Route {
  return asRoute(`/@${encodeURIComponent(handle.replace(/^@/, ''))}`)
}

/** `/earth?place=<placeId>` — a tagged place on the map (SCREEN 20). */
export function earthPlaceRoute(placeId: string): Route {
  return asRoute(`${ROUTES.earth}?place=${encodeURIComponent(placeId)}`)
}

/** `/earth?share=<conversationId>` — location sharing lives on the map (spec §75). */
export function earthShareRoute(conversationId: string): Route {
  return asRoute(`${ROUTES.earth}?share=${encodeURIComponent(conversationId)}`)
}
