/**
 * A tiny framework-agnostic request/response model plus the helpers every handler shares:
 * bearer extraction, JSON body parsing, RPC calls validated against the DTO schemas, and the
 * `EarthError` → HTTP mapping (statuses come from `EARTH_ERROR_HTTP_STATUS` in `@earth/domain`,
 * the single home of that table).
 */
import {
  EarthError,
  type EarthErrorCode,
  type EarthErrorDetails,
  httpStatusForErrorCode,
  parseEarthError,
} from '@earth/domain'
import type { Logger } from '@earth/observability'
import { z } from 'zod'

import type { RpcArgs, ServerDeps, SupabaseRpcClient } from './deps'

// ---------------------------------------------------------------------------
// Request / response
// ---------------------------------------------------------------------------

export interface EarthRequest {
  readonly method: string
  /** Absolute URL or path + query (`/api/feed?scope=world`). */
  readonly url: string
  readonly headers: Headers
  /** Parsed JSON body; rejects on malformed JSON. Empty bodies resolve to `undefined`. */
  json(): Promise<unknown>
  /** Raw body, needed for signature checks (LiveKit, verification vendor). */
  text(): Promise<string>
}

export interface EarthResponse {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  /** JSON-serialisable body. */
  readonly body: unknown
}

export const HTTP_STATUS = {
  ok: 200,
  accepted: 202,
  /** `GET /api/media/:bucket/:key*` redirects to the signed Storage URL. */
  found: 302,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  methodNotAllowed: 405,
  conflict: 409,
  tooManyRequests: 429,
  internal: 500,
} as const

export const CONTENT_TYPE_HEADER = 'content-type' as const
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8' as const
export const AUTHORIZATION_HEADER = 'authorization' as const
export const BEARER_PREFIX = 'Bearer ' as const
export const ALLOW_HEADER = 'allow' as const

const JSON_HEADERS: Readonly<Record<string, string>> = { [CONTENT_TYPE_HEADER]: JSON_CONTENT_TYPE }

export function ok(
  body: unknown,
  status: number = HTTP_STATUS.ok,
  headers: Readonly<Record<string, string>> = {},
): EarthResponse {
  return { status, headers: { ...JSON_HEADERS, ...headers }, body }
}

export interface ErrorBody {
  readonly error: {
    readonly code: EarthErrorCode
    readonly message: string
    readonly details?: EarthErrorDetails
  }
}

/** `{ error: { code, message[, details] } }`; `message` defaults to the code (never internals). */
export function error(
  status: number,
  code: EarthErrorCode,
  details?: EarthErrorDetails,
  message: string = code,
  headers: Readonly<Record<string, string>> = {},
): EarthResponse {
  const body: ErrorBody = {
    error: details === undefined ? { code, message } : { code, message, details },
  }
  return { status, headers: { ...JSON_HEADERS, ...headers }, body }
}

export function isErrorBody(value: unknown): value is ErrorBody {
  if (typeof value !== 'object' || value === null) return false
  const inner = (value as { error?: unknown }).error
  return (
    typeof inner === 'object' &&
    inner !== null &&
    typeof (inner as { code?: unknown }).code === 'string'
  )
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

export const REQUEST_FAILED_LOG_MESSAGE = 'server.request_failed' as const
/** Issues reported back for an invalid body, at most. */
export const MAX_REPORTED_ISSUES = 20

function issuesOf(zodError: z.ZodError): EarthErrorDetails {
  return {
    issues: zodError.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  }
}

/** Turns a zod failure on untrusted input into `EarthError('invalid_input')` with the issues. */
export function invalidInput(zodError: z.ZodError, field?: string): EarthError {
  const details = field === undefined ? issuesOf(zodError) : { field, ...issuesOf(zodError) }
  return new EarthError('invalid_input', { details, cause: zodError, message: 'invalid input' })
}

/** Response for a known `EarthError`: status from the domain table, details only for 4xx. */
export function errorResponse(err: EarthError): EarthResponse {
  const status = httpStatusForErrorCode(err.code)
  const details = status < HTTP_STATUS.internal ? err.details : undefined
  return error(status, err.code, details)
}

/**
 * Maps anything thrown by a handler to a response. `EarthError`s keep their code; zod errors on
 * request input become `invalid_input`; everything else is `internal` (logged, never echoed).
 */
export function mapError(err: unknown, logger?: Logger): EarthResponse {
  const earthError = err instanceof z.ZodError ? invalidInput(err) : parseEarthError(err)
  const response = errorResponse(earthError)
  if (logger !== undefined) {
    const fields = { code: earthError.code, status: response.status, error: earthError }
    if (response.status >= HTTP_STATUS.internal) logger.error(REQUEST_FAILED_LOG_MESSAGE, fields)
    else logger.debug(REQUEST_FAILED_LOG_MESSAGE, fields)
  }
  return response
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/** The bearer token of `Authorization: Bearer <token>`, or `null` when absent/malformed. */
export function optionalBearer(req: EarthRequest): string | null {
  const header = req.headers.get(AUTHORIZATION_HEADER)
  if (header === null) return null
  const trimmed = header.trim()
  if (trimmed.length <= BEARER_PREFIX.length) return null
  if (trimmed.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX.toLowerCase()) {
    return null
  }
  const token = trimmed.slice(BEARER_PREFIX.length).trim()
  return token.length > 0 ? token : null
}

/** The bearer token; throws `EarthError('not_authenticated')` (→ 401) when missing. */
export function requireBearer(req: EarthRequest): string {
  const token = optionalBearer(req)
  if (token === null) {
    throw new EarthError('not_authenticated', { details: { reason: 'missing_bearer' } })
  }
  return token
}

const PLACEHOLDER_ORIGIN = 'http://earth.invalid'

/** Parses `req.url` whether it is absolute or a bare path. */
export function requestUrl(req: EarthRequest): URL {
  return new URL(req.url, PLACEHOLDER_ORIGIN)
}

export function requestPath(req: EarthRequest): string {
  return requestUrl(req).pathname
}

export function requestQuery(req: EarthRequest): URLSearchParams {
  return requestUrl(req).searchParams
}

/** Reads the JSON body; malformed JSON → `invalid_input`. Absent bodies read as `undefined`. */
export async function readJson(req: EarthRequest): Promise<unknown> {
  try {
    return await req.json()
  } catch (cause) {
    throw new EarthError('invalid_input', {
      details: { field: 'body', reason: 'malformed_json' },
      cause,
      message: 'malformed JSON body',
    })
  }
}

/** Validates untrusted input with a zod schema; failures become `invalid_input`. */
export function parseInput<T>(schema: z.ZodType<T>, value: unknown, field?: string): T {
  const result = schema.safeParse(value)
  if (!result.success) throw invalidInput(result.error, field)
  return result.data
}

/** Reads and validates a JSON body; an empty body is treated as `{}`. */
export async function readBody<T>(req: EarthRequest, schema: z.ZodType<T>): Promise<T> {
  const raw = await readJson(req)
  return parseInput(schema, raw === undefined || raw === null ? {} : raw, 'body')
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

export const RPC_FAILED_LOG_MESSAGE = 'server.rpc_failed' as const

/**
 * PostgREST / Postgres codes that are not Earth codes but have an obvious meaning for the
 * caller of a caller-authenticated RPC: JWT problems (`PGRST301`–`PGRST303`) and RLS / grant
 * denials (`42501`, `insufficient_privilege`). The same table as `POSTGREST_CODE_TO_EARTH` in
 * `@earth/api`. Everything else unknown is `internal`.
 */
export const POSTGREST_CODE_TO_EARTH: Readonly<Record<string, EarthErrorCode>> = {
  '42501': 'forbidden',
  /** Any JWT verification failure (expired, bad signature, wrong audience). */
  PGRST301: 'not_authenticated',
  /** Anonymous access disallowed. */
  PGRST302: 'not_authenticated',
  /** JWT claims validation failed. */
  PGRST303: 'not_authenticated',
}

export interface RpcAsOptions {
  /**
   * Map PostgREST JWT / grant failures to caller-facing codes (`POSTGREST_CODE_TO_EARTH`). On
   * for the caller's own client: an expired session is a 401 the client can refresh, never a
   * 500. Off for the service-role client, where the same codes mean a misconfiguration that must
   * stay loud (`internal`, logged at error level).
   */
  readonly mapPostgrestCodes?: boolean | undefined
  /**
   * Echo the Postgres `details` / `hint` of a raised Earth code to the caller. On for the
   * caller's own RPCs (the database addressed them to the caller); off for service RPCs, whose
   * diagnostics may name other Humans or provider internals (spec §19, §78).
   */
  readonly exposeDetails?: boolean | undefined
}

/** The client's own RPCs. */
export const CALLER_RPC_OPTIONS: RpcAsOptions = { mapPostgrestCodes: true, exposeDetails: true }
/** Service-role RPCs. */
export const SERVICE_RPC_OPTIONS: RpcAsOptions = { mapPostgrestCodes: false, exposeDetails: false }

function postgrestCodeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' && code.length > 0 ? code : undefined
}

/** The `EarthError` a failed `rpc(name)` throws for a PostgREST error `cause`. */
export function rpcErrorFor(name: string, cause: unknown, options: RpcAsOptions = {}): EarthError {
  const parsed = parseEarthError(cause)
  if (parsed.code !== 'internal') {
    if (options.exposeDetails === false && parsed.details !== undefined) {
      return new EarthError(parsed.code, { cause, message: parsed.message })
    }
    return parsed
  }
  const code = postgrestCodeOf(cause)
  const mapped =
    options.mapPostgrestCodes === true && code !== undefined
      ? POSTGREST_CODE_TO_EARTH[code]
      : undefined
  if (mapped !== undefined) {
    return new EarthError(mapped, {
      cause,
      message: `rpc ${name}: ${code}`,
      details: { rpc: name, postgrestCode: code },
    })
  }
  return new EarthError('internal', {
    cause,
    message: `rpc ${name} failed`,
    details: { rpc: name },
  })
}

/** The caller's client: the user's when a token is present, the anon client for Visitors. */
export function clientFor(deps: ServerDeps, accessToken: string | null): SupabaseRpcClient {
  return accessToken === null ? deps.supabaseAnon : deps.supabaseForUser(accessToken)
}

/** Drops `undefined` values so PostgREST receives only the arguments that were set. */
export function cleanArgs(args: RpcArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

/**
 * Calls an RPC on `client` and validates the result with the DTO schema. Postgres errors raised as
 * `raise exception ... message = '<code>'` become the matching `EarthError`; a result that does not
 * match the contract is `internal` (a database/contract bug, never the caller's fault).
 */
export async function rpcAs<T>(
  client: SupabaseRpcClient,
  name: string,
  args: RpcArgs,
  schema: z.ZodType<T>,
  options: RpcAsOptions = {},
): Promise<T> {
  let result: { data: unknown; error: unknown }
  try {
    result = await client.rpc(name, cleanArgs(args))
  } catch (cause) {
    throw rpcErrorFor(name, cause, options)
  }
  if (result.error !== null && result.error !== undefined) {
    throw rpcErrorFor(name, result.error, options)
  }
  return parseOutput(schema, result.data, `rpc ${name}`)
}

/**
 * Validates something the server itself produced or received from the database against its DTO
 * schema. A mismatch is a contract bug on our side, so it is `internal` (500), never
 * `invalid_input` (which blames the caller).
 */
export function parseOutput<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new EarthError('internal', {
      cause: parsed.error,
      message: `${what} does not match its DTO`,
      details: { what, issues: issuesOf(parsed.error).issues },
    })
  }
  return parsed.data
}

/**
 * `rpcAs` on the caller's client (`token === null` → anon). A bad or expired session is
 * `not_authenticated`, an RLS / grant denial is `forbidden`; details raised by the database
 * are passed on to the caller they were addressed to.
 */
export function rpc<T>(
  deps: ServerDeps,
  accessToken: string | null,
  name: string,
  args: RpcArgs,
  schema: z.ZodType<T>,
): Promise<T> {
  return rpcAs(clientFor(deps, accessToken), name, args, schema, CALLER_RPC_OPTIONS)
}

/**
 * `rpcAs` on the service-role client. Earth codes keep their code and status but their Postgres
 * details never reach the caller (they are on the error's `cause` for the logs); auth / grant
 * failures of the service key are `internal`.
 */
export function rpcAdmin<T>(
  deps: ServerDeps,
  name: string,
  args: RpcArgs,
  schema: z.ZodType<T>,
): Promise<T> {
  return rpcAs(deps.supabaseAdmin, name, args, schema, SERVICE_RPC_OPTIONS)
}

/** Accepts any RPC result (for service RPCs whose exact shape is not part of the DTO contract). */
export const AnyRpcResultSchema = z.unknown()
