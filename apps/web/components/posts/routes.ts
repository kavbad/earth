/**
 * Routes of the post surfaces (SCREEN 06/07, spec §112 `/p/:postId`). Built on the shell's
 * `asRoute` so no screen spells a path as a string literal.
 */
import { type Audience, AudienceSchema, DEEP_LINK_PATHS, postUrl } from '@earth/domain'
import type { Route } from 'next'

import { asRoute } from '../../lib/routes'

/** `/compose` — SCREEN 06, inside the member shell. */
export const COMPOSE_PATH = '/compose' as const
/** `?replyTo=<postId>` opens the composer as a reply capped by the root audience (spec §72). */
export const REPLY_TO_QUERY = 'replyTo' as const
/** `?audience=<audience>` presets the audience (the Home radius the person came from). */
export const AUDIENCE_QUERY = 'audience' as const

export interface ComposeRouteOptions {
  readonly replyTo?: string
  readonly audience?: Audience
}

/** `/p/<postId>` — SCREEN 07 and the public link. */
export function postRoute(postId: string): Route {
  return asRoute(`${DEEP_LINK_PATHS.post}${encodeURIComponent(postId)}`)
}

export function composeRoute(options: ComposeRouteOptions = {}): Route {
  const params = new URLSearchParams()
  if (options.replyTo !== undefined) params.set(REPLY_TO_QUERY, options.replyTo)
  if (options.audience !== undefined) params.set(AUDIENCE_QUERY, options.audience)
  const query = params.toString()
  return asRoute(query === '' ? COMPOSE_PATH : `${COMPOSE_PATH}?${query}`)
}

/** The audience preset carried by `?audience=`, or `null` when absent or not an audience. */
export function audienceFromQuery(value: string | null | undefined): Audience | null {
  const parsed = AudienceSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** `https://earth.social/p/<postId>` — what "Share" copies (spec §112). */
export function postShareUrl(origin: string, postId: string): string {
  return postUrl(origin, postId)
}
