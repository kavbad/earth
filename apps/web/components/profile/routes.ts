/**
 * Routes of the profile, notifications and search surfaces (SCREEN 21–23; spec §112 `/@handle`).
 *
 * Next cannot name a folder `@[handle]`, so the public `/@handle` link is served by
 * `app/u/[handle]` through a rewrite in `next.config.ts`. Links always use the public form.
 */
import { DEEP_LINK_PATHS } from '@earth/domain'
import type { Route } from 'next'

import { asRoute } from '../../lib/routes'

/** Where `/@handle` is implemented (`next.config.ts` rewrites to it). */
export const PROFILE_IMPLEMENTATION_PATH = '/u' as const
export const NOTIFICATIONS_PATH = '/notifications' as const
export const SEARCH_PATH = '/search' as const
export const SEARCH_QUERY_PARAM = 'q' as const

/** `maya` · `@Maya ` → `maya`: the bare, lowercase handle. */
export function bareHandle(handle: string): string {
  return handle.trim().replace(/^@+/, '').toLowerCase()
}

/** `/@maya` — SCREEN 22 (spec §112). */
export function profileRoute(handle: string): Route {
  return asRoute(`${DEEP_LINK_PATHS.profile}${encodeURIComponent(bareHandle(handle))}`)
}

/** `/notifications` — SCREEN 23. */
export const NOTIFICATIONS_ROUTE: Route = asRoute(NOTIFICATIONS_PATH)

/** `/search` or `/search?q=<query>` — SCREEN 21. */
export function searchRoute(query?: string): Route {
  const q = query?.trim() ?? ''
  return asRoute(
    q.length === 0 ? SEARCH_PATH : `${SEARCH_PATH}?${SEARCH_QUERY_PARAM}=${encodeURIComponent(q)}`,
  )
}
