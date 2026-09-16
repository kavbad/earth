/**
 * The session cookie as a bearer, for the one kind of request that cannot carry one.
 *
 * The server tier authenticates by `Authorization: Bearer <access token>` and nothing else
 * (`@earth/server`, `optionalBearer`). A fetch from application code sets that header; an `<img>`,
 * `<audio>` or `<video>` element does not — the browser issues that request itself, with the
 * site's cookies and nothing more. `GET /api/media/:bucket/:key*` (spec §104) exists precisely so
 * those elements can show private media, so for that route, and only that route, this mount reads
 * the signed-in person's access token from the `@supabase/ssr` session cookie and presents it as
 * the bearer the tier expects. Every other route keeps requiring the header, so a cookie alone
 * never drives anything that changes state.
 */
import { AUTHORIZATION_HEADER, BEARER_PREFIX } from '@earth/server'

import { createSupabaseServerClient } from '../supabase/server'

/** Routes the browser fetches natively for media elements; the only ones a cookie may sign in to. */
export const COOKIE_BEARER_PATH_PREFIX = '/api/media/' as const

export type BearerFromCookies = () => Promise<string | null>

/** What `auth.getSession()` answers, narrowed to the one field this needs. */
export interface SessionResultLike {
  readonly data: { readonly session: { readonly access_token: string } | null }
}

export function accessTokenOf(result: SessionResultLike): string | null {
  const token = result.data.session?.access_token ?? ''
  return token.length > 0 ? token : null
}

/** The access token in Next's cookie store, or `null`: no session, or no request scope at all. */
export const bearerFromCookies: BearerFromCookies = async () => {
  try {
    const supabase = await createSupabaseServerClient()
    return accessTokenOf(await supabase.auth.getSession())
  } catch {
    return null
  }
}

/** Whether `request` is one the cookie may sign in to: a bare `GET` of the media route. */
export function acceptsCookieBearer(request: Request): boolean {
  return (
    request.method === 'GET' &&
    !request.headers.has(AUTHORIZATION_HEADER) &&
    new URL(request.url).pathname.startsWith(COOKIE_BEARER_PATH_PREFIX)
  )
}

/**
 * The same request, carrying the cookie session as its bearer when it may and when there is one;
 * otherwise `request` itself, untouched.
 */
export async function withCookieBearer(
  request: Request,
  bearer: BearerFromCookies = bearerFromCookies,
): Promise<Request> {
  if (!acceptsCookieBearer(request)) return request
  const token = await bearer()
  if (token === null) return request
  const headers = new Headers(request.headers)
  headers.set(AUTHORIZATION_HEADER, `${BEARER_PREFIX}${token}`)
  // A GET has no body, so nothing is lost in the copy.
  return new Request(request.url, { method: request.method, headers })
}
