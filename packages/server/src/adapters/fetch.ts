/**
 * Fetch API adapter: Next route handlers (and any WinterCG runtime) hand a `Request` to
 * `fromWebRequest` and return `toWebResponse(await server.handle(req))`. The body is read once and
 * cached so a handler may call `text()` (signature checks) and `json()` in any order.
 */
import {
  CONTENT_TYPE_HEADER,
  type EarthRequest,
  type EarthResponse,
  JSON_CONTENT_TYPE,
} from '../http'
import type { EarthServer } from '../router'

export function fromWebRequest(request: Request): EarthRequest {
  let cached: Promise<string> | undefined
  const text = (): Promise<string> => {
    if (cached === undefined) cached = request.text()
    return cached
  }
  return {
    method: request.method,
    url: request.url,
    headers: request.headers,
    text,
    async json() {
      const body = await text()
      if (body.trim() === '') return undefined
      return JSON.parse(body) as unknown
    },
  }
}

export function toWebResponse(response: EarthResponse): Response {
  const headers = new Headers({ [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE })
  for (const [name, value] of Object.entries(response.headers)) headers.set(name, value)
  const body = response.body === undefined ? null : JSON.stringify(response.body)
  return new Response(body, { status: response.status, headers })
}

/** `(request: Request) => Promise<Response>` for a route file: `export const POST = createFetchHandler(server)`. */
export function createFetchHandler(server: EarthServer): (request: Request) => Promise<Response> {
  return async (request) => toWebResponse(await server.handle(fromWebRequest(request)))
}
