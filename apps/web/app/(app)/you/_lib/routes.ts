/** Routes of SCREEN 24–25 (You and Settings), spelled once. */
import type { Route } from 'next'

import { ROUTES, asRoute } from '../../../../lib/routes'

export const YOU_ROUTES = {
  you: asRoute(ROUTES.you),
  settings: asRoute(`${ROUTES.you}/settings`),
  account: asRoute(`${ROUTES.you}/settings/account`),
  privacy: asRoute(`${ROUTES.you}/settings/privacy`),
  notifications: asRoute(`${ROUTES.you}/settings/notifications`),
  safety: asRoute(`${ROUTES.you}/settings/safety`),
  identity: asRoute(`${ROUTES.you}/settings/identity`),
} as const satisfies Record<string, Route>

/** `/chats/<conversationId>/info` — per-conversation notification prefs live on SCREEN 12. */
export function conversationInfoRoute(conversationId: string): Route {
  return asRoute(`${ROUTES.chats}/${encodeURIComponent(conversationId)}/info`)
}

/** `/p/<postId>` — a post of yours (spec §112). */
export function postRoute(postId: string): Route {
  return asRoute(`/p/${encodeURIComponent(postId)}`)
}
