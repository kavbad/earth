/**
 * Next route-handler adapter for the server tier: `Request` → `EarthRequest` →
 * `createEarthServer(deps).handle` → `Response` (ARCHITECTURE §6). The body is read lazily and
 * cached by `fromWebRequest`, so the LiveKit and verification webhooks verify their signatures
 * over the raw text. Vercel Cron requests are translated by `adaptCronRequest` before routing.
 *
 * Every failure is JSON `{ error: { code, message[, details] } }`: the router maps thrown
 * `EarthError`s itself; this adapter covers what happens outside it — a context that cannot be
 * built (invalid environment → `internal`, logged, never echoed) and anything the router lets
 * escape (captured by the monitor).
 */
import {
  type EarthResponse,
  fromWebRequest,
  mapError,
  requestPath,
  toWebResponse,
} from '@earth/server'
import { type Logger, createLogger } from '@earth/observability'

import { adaptCronRequest } from './cron'
import { getServerContext } from './deps'
import { WEB_APP_NAME } from './env'
import type { WebServerContext } from './wiring'

/** What Next calls for each method; `(request: Request)` is assignable to Next's signature. */
export type NextRouteHandler = (request: Request) => Promise<Response>

/**
 * Every method the router can answer with a JSON body — including `PUT`, which no route defines,
 * so the router's JSON 405 (with `Allow`) replaces Next's bare 405. `HEAD` and `OPTIONS` stay with
 * Next, which derives them from `GET` and the exported methods.
 */
export interface EarthRouteHandlers {
  readonly GET: NextRouteHandler
  readonly POST: NextRouteHandler
  readonly PUT: NextRouteHandler
  readonly PATCH: NextRouteHandler
  readonly DELETE: NextRouteHandler
}

export interface MakeRouteHandlerOptions {
  /** Defaults to the memoised production context. */
  readonly context?: (() => WebServerContext) | undefined
  /** Logger used when the context itself cannot be built. */
  readonly fallbackLogger?: Logger | undefined
}

export const CONTEXT_FAILED_LOG_MESSAGE = 'server.context_failed' as const
export const ROUTE_TAG = 'route' as const

/** The response for a context that could not be built: 500 `internal`, cause logged only. */
export function contextFailureResponse(cause: unknown, logger: Logger): EarthResponse {
  logger.error(CONTEXT_FAILED_LOG_MESSAGE, { error: cause })
  return mapError(cause)
}

export function makeRouteHandler(options: MakeRouteHandlerOptions = {}): EarthRouteHandlers {
  const getContext = options.context ?? getServerContext
  const fallbackLogger =
    options.fallbackLogger ?? createLogger({ base: { service: WEB_APP_NAME } })

  const handle: NextRouteHandler = async (request) => {
    let context: WebServerContext
    try {
      context = getContext()
    } catch (cause) {
      return toWebResponse(contextFailureResponse(cause, fallbackLogger))
    }
    const req = adaptCronRequest(fromWebRequest(request), context.cron)
    try {
      return toWebResponse(await context.server.handle(req))
    } catch (cause) {
      context.monitor.captureException(cause, { tags: { [ROUTE_TAG]: requestPath(req) } })
      return toWebResponse(mapError(cause, context.logger))
    }
  }

  return { GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle }
}
