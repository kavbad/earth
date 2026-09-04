/**
 * The two transports behind every client method — Supabase RPC/select and `fetch` to the server
 * tier — plus the shared conversions: input validation → `EarthError('invalid_input')`, PostgREST
 * errors → `EarthError` (`message` carries the code, ARCHITECTURE §5), HTTP errors
 * (`{ error: { code } }` bodies, then status fallbacks) → `EarthError`, and DTO validation of
 * every result → `EarthError('internal')` on a contract mismatch.
 */
import {
  EarthError,
  type EarthErrorCode,
  type EarthErrorDetails,
  parseEarthError,
} from '@earth/domain'
import type { z } from 'zod'

import type { ArgNames, ArgsOf, RouteSpec, RpcSpec } from './manifest'
import { fillRoute } from './rpc'
import type {
  AccessTokenGetter,
  PostgrestErrorLike,
  PostgrestResultLike,
  RpcArgs,
  ServerFetch,
  ServerFetchInit,
  ServerFetchResponse,
  SupabaseLike,
  TableLike,
} from './types'

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Issues reported in `details` for an invalid input or a contract mismatch, at most. */
export const MAX_REPORTED_ISSUES = 20

export interface ReportedIssue {
  readonly path: string
  readonly message: string
}

export function issuesOf(error: z.ZodError): readonly ReportedIssue[] {
  return error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }))
}

/** Turns a zod failure on caller input into `EarthError('invalid_input')` with the issues. */
export function invalidInput(error: z.ZodError, field?: string): EarthError {
  const issues = issuesOf(error)
  const details: EarthErrorDetails = field === undefined ? { issues } : { field, issues }
  return new EarthError('invalid_input', { details, cause: error, message: 'invalid input' })
}

/** Validates caller input; failures throw `EarthError('invalid_input')`. */
export function parseInput<T>(schema: z.ZodType<T>, value: unknown, field?: string): T {
  const result = schema.safeParse(value)
  if (!result.success) throw invalidInput(result.error, field)
  return result.data
}

/**
 * Validates what the database or the server returned against its DTO. A mismatch is a contract
 * bug (never the caller's fault), so it is `internal`.
 */
export function parseOutput<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new EarthError('internal', {
      cause: result.error,
      message: `${what} does not match its DTO`,
      details: { what, issues: issuesOf(result.error) },
    })
  }
  return result.data
}

// ---------------------------------------------------------------------------
// PostgREST errors
// ---------------------------------------------------------------------------

/**
 * PostgREST / Postgres codes that are not Earth codes but have an obvious meaning for callers:
 * RLS or grant denials and JWT problems. Everything else unknown is `internal`.
 */
export const POSTGREST_CODE_TO_EARTH: Readonly<Record<string, EarthErrorCode>> = {
  /** `insufficient_privilege`: RLS or a missing grant. */
  '42501': 'forbidden',
  /** JWT expired. */
  PGRST301: 'not_authenticated',
  /** JWT invalid. */
  PGRST303: 'not_authenticated',
}

/**
 * Maps a PostgREST error to an `EarthError`. `message` equal to a known code (from
 * `raise exception ... message = '<code>'`) wins; otherwise the SQLSTATE/PGRST code is consulted
 * and anything else is `internal` with the original error as `cause`.
 */
export function postgrestErrorToEarthError(error: PostgrestErrorLike, what: string): EarthError {
  const parsed = parseEarthError(error)
  if (parsed.code !== 'internal') return parsed
  const code = typeof error.code === 'string' && error.code.length > 0 ? error.code : undefined
  const details: EarthErrorDetails = code === undefined ? { what } : { what, postgrestCode: code }
  const mapped = code === undefined ? undefined : POSTGREST_CODE_TO_EARTH[code]
  if (mapped !== undefined) {
    return new EarthError(mapped, { details, cause: error, message: `${what}: ${error.message}` })
  }
  return new EarthError('internal', {
    details,
    cause: error,
    message: `${what} failed: ${error.message}`,
  })
}

/** Drops `undefined` values so PostgREST receives only the arguments that were set. */
export function cleanArgs(args: RpcArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

// ---------------------------------------------------------------------------
// HTTP errors
// ---------------------------------------------------------------------------

/** Fallback mapping when an error response carries no `{ error: { code } }` body. */
export const HTTP_STATUS_TO_EARTH: Readonly<Record<number, EarthErrorCode>> = {
  400: 'invalid_input',
  401: 'not_authenticated',
  403: 'forbidden',
  429: 'rate_limited',
}

export function httpErrorToEarthError(status: number, body: unknown, route: string): EarthError {
  if (body !== undefined) {
    const parsed = parseEarthError(body)
    if (parsed.code !== 'internal') return parsed
  }
  const details: EarthErrorDetails = { route, status }
  const mapped = HTTP_STATUS_TO_EARTH[status]
  if (mapped !== undefined) {
    return new EarthError(mapped, { details, cause: body, message: `${route} responded ${status}` })
  }
  return new EarthError('internal', {
    details,
    cause: body,
    message: `${route} responded ${status}`,
  })
}

export const HTTP_METHODS = ['GET', 'POST'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

export const SERVER_AUTH_MODES = ['required', 'optional'] as const
export type ServerAuthMode = (typeof SERVER_AUTH_MODES)[number]

export interface ServerRequest {
  readonly method: HttpMethod
  /** Route path starting with `/api/`. */
  readonly path: string
  /** Query parameters; `null`/`undefined` values are omitted. */
  readonly query?: Readonly<Record<string, string | null | undefined>> | undefined
  /** JSON body (POST). */
  readonly body?: unknown
  /** `required`: throw `not_authenticated` before the request when no session exists. */
  readonly auth: ServerAuthMode
}

/** What a `RouteSpec` call adds to the spec: path parameters, query and body. */
export interface RouteRequest {
  /** Values for the `:name` segments of the spec's path. */
  readonly params?: Readonly<Record<string, string>> | undefined
  readonly query?: Readonly<Record<string, string | null | undefined>> | undefined
  readonly body?: unknown
}

const HEADER_ACCEPT = 'accept' as const
const HEADER_CONTENT_TYPE = 'content-type' as const
const HEADER_AUTHORIZATION = 'authorization' as const
const JSON_MEDIA_TYPE = 'application/json' as const
const BEARER_PREFIX = 'Bearer ' as const

export function serverUrl(
  baseUrl: string,
  path: string,
  query?: Readonly<Record<string, string | null | undefined>>,
): string {
  const params = new URLSearchParams()
  if (query !== undefined) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== null && value !== undefined && value.length > 0) params.set(key, value)
    }
  }
  const search = params.toString()
  return `${baseUrl.replace(/\/+$/, '')}${path}${search.length > 0 ? `?${search}` : ''}`
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface TransportOptions {
  readonly supabase: SupabaseLike
  readonly serverBaseUrl: string
  readonly fetch: ServerFetch
  readonly getAccessToken?: AccessTokenGetter | undefined
  readonly randomId: () => string
}

/** What every namespace is built on. */
export interface Transport {
  readonly supabase: SupabaseLike
  /**
   * Calls the RPC of a manifest spec: `args` must carry exactly the spec's argument names (an
   * `undefined` value is not sent) and the result is parsed with the spec's schema, or ignored
   * when the spec's result is `void`.
   */
  call<A extends ArgNames, T>(spec: RpcSpec<A, T>, args: ArgsOf<A>): Promise<T>
  /** Calls the server route of a manifest spec (method, path template and auth come from the spec). */
  route<A extends ArgNames, T>(spec: RouteSpec<A, T>, request?: RouteRequest): Promise<T>
  /** Calls an RPC with snake_case args and validates the result. */
  rpc<T>(name: string, args: RpcArgs, schema: z.ZodType<T>): Promise<T>
  /** Calls an RPC whose result is not part of the contract; only errors matter. */
  rpcVoid(name: string, args: RpcArgs): Promise<void>
  /** A direct table/view read or insert, validated. */
  query<T>(
    what: string,
    run: (table: TableLike) => PromiseLike<PostgrestResultLike>,
    table: string,
    schema: z.ZodType<T>,
  ): Promise<T>
  /** A server-tier route with a JSON result. */
  server<T>(request: ServerRequest, schema: z.ZodType<T>): Promise<T>
  /** A server-tier route whose body is ignored (accepted / no content). */
  serverVoid(request: ServerRequest): Promise<void>
  /** The caller's Supabase access token, or `null` for Visitors. Never throws. */
  accessToken(): Promise<string | null>
  randomId(): string
}

type JsonBody = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

function parseJsonBody(text: string): JsonBody {
  if (text.trim().length === 0) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch {
    return { ok: false }
  }
}

export function createTransport(options: TransportOptions): Transport {
  const { supabase, serverBaseUrl } = options
  // Copied into locals so `fetch` is invoked unbound: browsers throw "Illegal invocation" when
  // `window.fetch` is called with another `this`.
  const fetchImpl = options.fetch
  const getAccessToken = options.getAccessToken

  const accessToken = async (): Promise<string | null> => {
    try {
      if (getAccessToken !== undefined) {
        const token = await getAccessToken()
        return typeof token === 'string' && token.length > 0 ? token : null
      }
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      return typeof token === 'string' && token.length > 0 ? token : null
    } catch {
      // A broken session getter must not break reads Visitors may perform; the route decides.
      return null
    }
  }

  const rawRpc = async (name: string, args: RpcArgs): Promise<unknown> => {
    const what = `rpc ${name}`
    let result: PostgrestResultLike
    try {
      result = await supabase.rpc(name, cleanArgs(args))
    } catch (cause) {
      throw parseEarthError(cause)
    }
    if (result.error !== null && result.error !== undefined) {
      throw postgrestErrorToEarthError(result.error, what)
    }
    return result.data
  }

  const rawServer = async (request: ServerRequest): Promise<{ status: number; body: unknown }> => {
    const route = `${request.method} ${request.path}`
    const token = await accessToken()
    if (request.auth === 'required' && token === null) {
      throw new EarthError('not_authenticated', {
        details: { route, reason: 'missing_session' },
        message: `${route} needs a signed-in caller`,
      })
    }
    const headers: Record<string, string> = { [HEADER_ACCEPT]: JSON_MEDIA_TYPE }
    if (request.body !== undefined) headers[HEADER_CONTENT_TYPE] = JSON_MEDIA_TYPE
    if (token !== null) headers[HEADER_AUTHORIZATION] = `${BEARER_PREFIX}${token}`
    const init: ServerFetchInit =
      request.body === undefined
        ? { method: request.method, headers }
        : { method: request.method, headers, body: JSON.stringify(request.body) }
    const url = serverUrl(serverBaseUrl, request.path, request.query)

    let response: ServerFetchResponse
    try {
      response = await fetchImpl(url, init)
    } catch (cause) {
      throw new EarthError('internal', {
        details: { route, reason: 'network_error' },
        cause,
        message: `${route}: network error`,
      })
    }
    let text = ''
    try {
      text = await response.text()
    } catch {
      text = ''
    }
    const body = parseJsonBody(text)
    if (!response.ok) {
      throw httpErrorToEarthError(response.status, body.ok ? body.value : text, route)
    }
    if (!body.ok) {
      throw new EarthError('internal', {
        details: { route, reason: 'malformed_json', status: response.status },
        message: `${route}: malformed JSON response`,
      })
    }
    return { status: response.status, body: body.value }
  }

  return {
    supabase,
    async call(spec, args) {
      const data = await rawRpc(spec.rpc, args)
      if (spec.schema === null) return undefined as never
      return parseOutput(spec.schema, data, `rpc ${spec.rpc}`)
    },
    async route(spec, request = {}) {
      const base: ServerRequest = {
        method: spec.httpMethod,
        path: fillRoute(spec.path, request.params ?? {}),
        query: request.query,
        auth: spec.auth,
      }
      const serverRequest: ServerRequest =
        request.body === undefined ? base : { ...base, body: request.body }
      const { body } = await rawServer(serverRequest)
      if (spec.schema === null) return undefined as never
      return parseOutput(spec.schema, body, `${spec.httpMethod} ${spec.path}`)
    },
    async rpc(name, args, schema) {
      const data = await rawRpc(name, args)
      return parseOutput(schema, data, `rpc ${name}`)
    },
    async rpcVoid(name, args) {
      await rawRpc(name, args)
    },
    async query(what, run, table, schema) {
      let result: PostgrestResultLike
      try {
        result = await run(supabase.from(table))
      } catch (cause) {
        throw parseEarthError(cause)
      }
      if (result.error !== null && result.error !== undefined) {
        throw postgrestErrorToEarthError(result.error, what)
      }
      return parseOutput(schema, result.data, what)
    },
    async server(request, schema) {
      const { body } = await rawServer(request)
      return parseOutput(schema, body, `${request.method} ${request.path}`)
    },
    async serverVoid(request) {
      await rawServer(request)
    },
    accessToken,
    randomId: options.randomId,
  }
}

/** `crypto.randomUUID()` where available (web, Node, Expo with the polyfill), else a v4-shaped fallback. */
export function defaultRandomId(): string {
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (cryptoLike !== undefined && typeof cryptoLike.randomUUID === 'function') {
    return cryptoLike.randomUUID()
  }
  const hex = (): string =>
    Math.floor(Math.random() * 0x10000)
      .toString(16)
      .padStart(4, '0')
  const variant = (0x8000 | (Math.floor(Math.random() * 0x1000) & 0x0fff)).toString(16)
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-${variant}-${hex()}${hex()}${hex()}`
}
