/**
 * The headers a native media source needs to fetch private media from the server tier's media
 * route (`mediaRouteUrl`, spec §104). The route authenticates by bearer only; on the web the
 * browser's cookie stands in for it, but a native `Image`, `Video` or `Sound` sends nothing of its
 * own, so the session's access token rides along as a request header.
 */
import { useMemo } from 'react'

import { useSession } from '@/lib/providers'

export type MediaRequestHeaders = Readonly<Record<string, string>>

export const NO_HEADERS: MediaRequestHeaders = Object.freeze({})

export function mediaRequestHeaders(
  session: { readonly access_token: string } | null,
): MediaRequestHeaders {
  if (session === null || session.access_token.length === 0) return NO_HEADERS
  return { Authorization: `Bearer ${session.access_token}` }
}

export function useMediaRequestHeaders(): MediaRequestHeaders {
  const session = useSession()
  const auth = session.session
  return useMemo(() => mediaRequestHeaders(auth), [auth])
}
