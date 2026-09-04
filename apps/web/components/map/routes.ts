/**
 * Routes of SCREEN 20. Chats hand off with `/earth?share=<conversationId>` and
 * `/earth?place=<placeId>` (see `components/chats/routes.ts`); You opens `/earth?you=1`.
 */
import { DEEP_LINK_PATHS } from '@earth/domain'
import type { Route } from 'next'

import { ROUTES, asRoute } from '../../lib/routes'

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

export function earthRoute(params: EarthRouteParams = {}): Route {
  const query = new URLSearchParams()
  if (params.placeId !== undefined) query.set(EARTH_QUERY.place, params.placeId)
  if (params.shareConversationId !== undefined)
    query.set(EARTH_QUERY.share, params.shareConversationId)
  if (params.you === true) query.set(EARTH_QUERY.you, '1')
  const suffix = query.toString()
  return asRoute(suffix === '' ? ROUTES.earth : `${ROUTES.earth}?${suffix}`)
}

/** `/p/<postId>` — a Moment opens its post (spec §112). */
export function momentRoute(postId: string): Route {
  return asRoute(`${DEEP_LINK_PATHS.post}${encodeURIComponent(postId)}`)
}
