/**
 * Route table for every server-tier route of ARCHITECTURE §6 plus a health route, and
 * `createEarthServer(deps)` which turns a request into a response. Matching is by method and
 * path segments (`:param` captures one segment); handlers are wrapped so any thrown value becomes
 * the JSON error shape of `./http.ts`.
 */
import { handleAccountDelete } from './account/delete'
import { handleAnalyticsIngest } from './analytics/ingest'
import {
  handleVerificationResult,
  handleVerificationStart,
  handleVerificationWebhook,
} from './claim/verification'
import type { ServerDeps } from './deps'
import { handleRtcDiagnostics } from './diagnostics/rtc'
import { handleFeed, handleLive } from './feed/handler'
import {
  ALLOW_HEADER,
  type EarthRequest,
  type EarthResponse,
  HTTP_STATUS,
  error,
  mapError,
  ok,
  requestPath,
} from './http'
import { handleMetricsDaily } from './metrics/daily'
import { handlePushDispatch } from './push/dispatch'
import { handleRoomsSweep } from './rooms/sweep'
import { handleRoomToken } from './rooms/token'
import { handleLiveKitWebhook } from './rooms/webhook'

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

export type RouteParams = Readonly<Record<string, string>>

export type RouteHandler = (
  deps: ServerDeps,
  req: EarthRequest,
  params: RouteParams,
) => Promise<EarthResponse>

export interface RouteDefinition {
  readonly name: string
  readonly method: HttpMethod
  /** `/api/rooms/:id/token` — `:name` captures exactly one path segment. */
  readonly pattern: string
  readonly handler: RouteHandler
}

export const SERVICE_NAME = 'earth-server' as const

export interface HealthBody {
  readonly ok: true
  readonly service: typeof SERVICE_NAME
  readonly now: string
}

export async function handleHealth(deps: ServerDeps): Promise<EarthResponse> {
  const body: HealthBody = { ok: true, service: SERVICE_NAME, now: deps.now().toISOString() }
  return ok(body)
}

function param(params: RouteParams, name: string): string {
  return params[name] ?? ''
}

/** Every route of ARCHITECTURE §6, in matching order (static segments win over params anyway). */
export const ROUTES: readonly RouteDefinition[] = [
  { name: 'health', method: 'GET', pattern: '/api/health', handler: (deps) => handleHealth(deps) },
  {
    name: 'rooms.token',
    method: 'POST',
    pattern: '/api/rooms/:id/token',
    handler: (deps, req, params) => handleRoomToken(deps, req, param(params, 'id')),
  },
  {
    name: 'livekit.webhook',
    method: 'POST',
    pattern: '/api/livekit/webhook',
    handler: handleLiveKitWebhook,
  },
  {
    name: 'claim.verification.start',
    method: 'POST',
    pattern: '/api/claim/verification/start',
    handler: handleVerificationStart,
  },
  {
    name: 'claim.verification.webhook',
    method: 'POST',
    pattern: '/api/claim/verification/webhook',
    handler: handleVerificationWebhook,
  },
  {
    name: 'claim.verification.result',
    method: 'GET',
    pattern: '/api/claim/verification/:sessionId',
    handler: (deps, req, params) => handleVerificationResult(deps, req, param(params, 'sessionId')),
  },
  { name: 'feed', method: 'GET', pattern: '/api/feed', handler: handleFeed },
  { name: 'live', method: 'GET', pattern: '/api/live', handler: handleLive },
  {
    name: 'account.delete',
    method: 'POST',
    pattern: '/api/account/delete',
    handler: handleAccountDelete,
  },
  {
    name: 'internal.push.dispatch',
    method: 'POST',
    pattern: '/api/internal/push/dispatch',
    handler: handlePushDispatch,
  },
  {
    name: 'internal.rooms.sweep',
    method: 'POST',
    pattern: '/api/internal/rooms/sweep',
    handler: handleRoomsSweep,
  },
  {
    name: 'internal.metrics.daily',
    method: 'POST',
    pattern: '/api/internal/metrics/daily',
    handler: handleMetricsDaily,
  },
  {
    name: 'analytics.ingest',
    method: 'POST',
    pattern: '/api/analytics/ingest',
    handler: handleAnalyticsIngest,
  },
  {
    name: 'diagnostics.rtc',
    method: 'POST',
    pattern: '/api/diagnostics/rtc',
    handler: handleRtcDiagnostics,
  },
]

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0)
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

/** Params when `pattern` matches `path` (segment by segment), else `null`. */
export function matchPattern(pattern: string, path: string): RouteParams | null {
  const expected = segmentsOf(pattern)
  const actual = segmentsOf(path)
  if (expected.length !== actual.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < expected.length; i += 1) {
    const want = expected[i] ?? ''
    const got = actual[i] ?? ''
    if (want.startsWith(':')) {
      const value = decodeSegment(got)
      if (value === null || value.length === 0) return null
      params[want.slice(1)] = value
    } else if (want !== got) {
      return null
    }
  }
  return params
}

export type RouteMatch =
  | { readonly kind: 'matched'; readonly route: RouteDefinition; readonly params: RouteParams }
  | { readonly kind: 'method_not_allowed'; readonly allowed: readonly HttpMethod[] }
  | { readonly kind: 'not_found' }

export function matchRoute(
  routes: readonly RouteDefinition[],
  method: string,
  path: string,
): RouteMatch {
  const upper = method.toUpperCase()
  const allowed: HttpMethod[] = []
  for (const route of routes) {
    const params = matchPattern(route.pattern, path)
    if (params === null) continue
    if (route.method === upper) return { kind: 'matched', route, params }
    if (!allowed.includes(route.method)) allowed.push(route.method)
  }
  return allowed.length > 0 ? { kind: 'method_not_allowed', allowed } : { kind: 'not_found' }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export interface EarthServer {
  readonly routes: readonly RouteDefinition[]
  handle(req: EarthRequest): Promise<EarthResponse>
}

export interface CreateEarthServerOptions {
  /** Defaults to `ROUTES`. */
  readonly routes?: readonly RouteDefinition[]
}

export function createEarthServer(
  deps: ServerDeps,
  options: CreateEarthServerOptions = {},
): EarthServer {
  const routes = options.routes ?? ROUTES
  return {
    routes,
    async handle(req) {
      const match = matchRoute(routes, req.method, requestPath(req))
      switch (match.kind) {
        case 'not_found':
          return error(HTTP_STATUS.notFound, 'not_visible', { reason: 'no_such_route' })
        case 'method_not_allowed':
          return error(
            HTTP_STATUS.methodNotAllowed,
            'invalid_input',
            { reason: 'method_not_allowed', allowed: match.allowed },
            'method not allowed',
            { [ALLOW_HEADER]: match.allowed.join(', ') },
          )
        case 'matched':
          try {
            return await match.route.handler(deps, req, match.params)
          } catch (cause) {
            return mapError(cause, deps.logger.child({ route: match.route.name }))
          }
      }
    },
  }
}
