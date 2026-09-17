/**
 * Field redaction and JSON-safe serialisation shared by the structured logger, the error
 * monitors and the RTC diagnostics emitter (spec §131 "structured logging", §14 error monitoring;
 * ARCHITECTURE §6 `ServerDeps.logger`, §14 secrets).
 *
 * ## Keys
 *
 * Keys are compared after normalisation (lower-case, `_` / `-` / whitespace removed), so
 * `session_secret`, `sessionSecret` and `SESSION-SECRET` are all redacted. A key is redacted when
 * its normalised form *ends with* one of `REDACTED_KEYS` (normalised) — covering the exact names
 * plus compound forms such as `accessToken`, `livekit_token`, `clientSecret`,
 * `SUPABASE_SERVICE_ROLE_KEY` and `x-authorization` — or *equals* one of `REDACTED_EXACT_KEYS`
 * (short names such as `phone` and `lat` whose suffix would over-match `microphone` / `flat`).
 * `token_hash`-style keys are deliberately not redacted: hashes are lookup keys (ARCHITECTURE §5),
 * never the plaintext. Bare `key` is not redacted either: flag keys, cache keys and idempotency
 * keys are not secrets.
 *
 * PII keys (`email`, `phone`, exact coordinates) are redacted too: monitor identity is only
 * `humans.id` / `guest_sessions.id` plus the public handle (`./monitor`), and exact location is
 * never public (spec §128). Diagnostics do not need either.
 *
 * ## Strings
 *
 * Secrets also travel inside strings — `Authorization: Bearer …` headers, `?access_token=…` on
 * LiveKit signalling URLs, JWTs, `user:password@host` in connection strings — and inside error
 * messages and stacks built from them. `redactString` scrubs those shapes and is applied to every
 * string value, error message and stack that passes through serialisation.
 *
 * ## Serialisation
 *
 * Serialisation turns anything into plain JSON: `Error` (with `EarthError` code/details and the
 * `cause` chain), `Date`, `Map`, `Set`, `bigint`, circular references (including errors that
 * reference themselves through `details` or `cause`), throwing getters and excessive depth are all
 * handled so a log line can never throw.
 */
import { isEarthError } from '@earth/domain'

export const REDACTED_KEYS = [
  // Credentials and session material.
  'token',
  'secret',
  'session_secret',
  'password',
  'passwd',
  'pwd',
  'passphrase',
  'passcode',
  'authorization',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'jwt',
  'otp',
  // Key material (ARCHITECTURE §14 server secrets end in `_KEY`).
  'apiKey',
  'secretKey',
  'privateKey',
  'signingKey',
  'serviceKey',
  'serviceRoleKey',
  'serverKey',
  'vendorKey',
  'accessKey',
  // PII: contact details and exact location (spec §128).
  'email',
  'phoneNumber',
  'latitude',
  'longitude',
  'coordinates',
  'coords',
] as const
export type RedactedKey = (typeof REDACTED_KEYS)[number]

/** Keys redacted only on an exact (normalised) match; as suffixes they would over-match. */
export const REDACTED_EXACT_KEYS = ['phone', 'mobile', 'lat', 'lng', 'lon'] as const
export type RedactedExactKey = (typeof REDACTED_EXACT_KEYS)[number]

export const REDACTED_VALUE = '[REDACTED]' as const
export const CIRCULAR_VALUE = '[Circular]' as const
export const TRUNCATED_VALUE = '[Truncated]' as const
/** Replaces a value whose own properties cannot be read (a throwing getter or proxy). */
export const UNSERIALIZABLE_VALUE = '[Unserializable]' as const
/** Stands in for a fields object whose own properties cannot be read. */
export const UNSERIALIZABLE_FIELDS: Readonly<Record<string, unknown>> = Object.freeze({
  unserializable: true,
})
/** Name reported for thrown values that are not `Error` instances. */
export const NON_ERROR_NAME = 'NonError' as const
/** Nesting depth beyond which values are replaced with `TRUNCATED_VALUE`. */
export const MAX_SERIALIZATION_DEPTH = 8
/** How many `cause` links of an error chain are serialised. */
export const MAX_ERROR_CAUSE_DEPTH = 3

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '')
}

const NORMALIZED_REDACTED_KEYS: readonly string[] = REDACTED_KEYS.map(normalizeKey)
const NORMALIZED_EXACT_KEYS: ReadonlySet<string> = new Set(REDACTED_EXACT_KEYS.map(normalizeKey))

/** True when a field with this key must be replaced by `REDACTED_VALUE`. */
export function isRedactedKey(key: string): boolean {
  const normalized = normalizeKey(key)
  if (normalized.length === 0) return false
  if (NORMALIZED_EXACT_KEYS.has(normalized)) return true
  return NORMALIZED_REDACTED_KEYS.some((redacted) => normalized.endsWith(redacted))
}

// ---------------------------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------------------------

/** `Authorization` header values: `Bearer <jwt>`, `Basic <base64>`. */
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi
/** A JWT: two base64url JSON objects (`{"` encodes to `eyJ`) and a signature. */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g
/** `scheme://user:password@host` userinfo in URLs and connection strings. */
const URL_USERINFO_PATTERN = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi
/** `name=value` pairs in query strings, fragments, form bodies and `key=value` connection strings. */
const KEY_VALUE_PATTERN = /(^|[?&#;,\s])([A-Za-z0-9_.-]+)=([^&#;,\s"'`]+)/g
/** In a query string a bare `key` is always an API key (`?key=AIza…`). */
const QUERY_KEY_NAME = 'key'

function isRedactedParamName(name: string): boolean {
  return isRedactedKey(name) || normalizeKey(name) === QUERY_KEY_NAME
}

/**
 * Scrubs secrets embedded in free text: bearer/basic credentials, JWTs, URL userinfo and
 * `name=value` pairs whose name is a redacted key. Everything else is returned verbatim.
 */
export function redactString(text: string): string {
  if (text.length === 0) return text
  return text
    .replace(AUTH_SCHEME_PATTERN, (_match, scheme: string) => `${scheme} ${REDACTED_VALUE}`)
    .replace(JWT_PATTERN, REDACTED_VALUE)
    .replace(URL_USERINFO_PATTERN, (_match, scheme: string) => `${scheme}${REDACTED_VALUE}@`)
    .replace(KEY_VALUE_PATTERN, (match, lead: string, name: string) =>
      isRedactedParamName(name) ? `${lead}${name}=${REDACTED_VALUE}` : match,
    )
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export interface SerializedError {
  readonly name: string
  readonly message: string
  readonly stack?: string
  /** `EarthError.code`, or a string `code` property on other errors (Node's `ECONNRESET` etc.). */
  readonly code?: string
  readonly details?: Readonly<Record<string, unknown>>
  readonly cause?: SerializedError
}

interface MutableSerializedError {
  name: string
  message: string
  stack?: string
  code?: string
  details?: Readonly<Record<string, unknown>>
  cause?: SerializedError
}

/** Converts any thrown value into a plain, JSON-safe, redacted description. */
export function serializeError(value: unknown): SerializedError {
  return serializeErrorAt(value, 0, 0, new Set())
}

function serializeErrorAt(
  value: unknown,
  depth: number,
  causeDepth: number,
  path: Set<object>,
): SerializedError {
  if (!(value instanceof Error)) {
    return { name: NON_ERROR_NAME, message: describeNonError(value, depth, path) }
  }
  if (path.has(value)) return { name: value.name, message: CIRCULAR_VALUE }
  path.add(value)
  try {
    const out: MutableSerializedError = {
      name: value.name,
      message: redactString(value.message),
    }
    if (typeof value.stack === 'string') out.stack = redactString(value.stack)
    if (isEarthError(value)) {
      out.code = value.code
      if (value.details !== undefined) {
        const entries = readEntries(value.details)
        out.details =
          entries === null ? UNSERIALIZABLE_FIELDS : sanitizeEntries(entries, depth, path)
      }
    } else {
      const code: unknown = (value as { code?: unknown }).code
      if (typeof code === 'string') out.code = code
    }
    const cause: unknown = (value as { cause?: unknown }).cause
    if (cause !== undefined && causeDepth < MAX_ERROR_CAUSE_DEPTH) {
      out.cause = serializeErrorAt(cause, depth + 1, causeDepth + 1, path)
    }
    return out
  } finally {
    path.delete(value)
  }
}

function describeNonError(value: unknown, depth: number, path: Set<object>): string {
  if (typeof value === 'string') return redactString(value)
  try {
    const json = JSON.stringify(sanitizeAt(value, depth, path))
    return json === undefined ? stringOf(value) : json
  } catch {
    return stringOf(value)
  }
}

/** `String(value)` that survives a throwing `toString` / `Symbol.toPrimitive`. */
function stringOf(value: unknown): string {
  try {
    return redactString(String(value))
  } catch {
    return UNSERIALIZABLE_VALUE
  }
}

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

/** `JSON.stringify` that never throws: values are sanitised first and failures fall back to `String`. */
export function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(sanitizeValue(value))
    return json === undefined ? stringOf(value) : json
  } catch {
    return stringOf(value)
  }
}

/** Deep-copies `value` into plain JSON-safe data, redacting sensitive keys and strings along the way. */
export function sanitizeValue(value: unknown): unknown {
  return sanitizeAt(value, 0, new Set())
}

/** Redacts and sanitises a fields object (the shape every log line and monitor context carries). */
export function redactFields(fields: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const entries = readEntries(fields)
  return entries === null ? { ...UNSERIALIZABLE_FIELDS } : sanitizeEntries(entries, 0, new Set())
}

/** `Object.entries` that reports a throwing getter or proxy instead of propagating it. */
function readEntries(value: object): ReadonlyArray<readonly [string, unknown]> | null {
  try {
    return Object.entries(value)
  } catch {
    return null
  }
}

function sanitizeAt(value: unknown, depth: number, path: Set<object>): unknown {
  switch (typeof value) {
    case 'string':
      return redactString(value)
    case 'boolean':
      return value
    case 'number':
      return Number.isFinite(value) ? value : String(value)
    case 'bigint':
      return value.toString()
    case 'symbol':
      return value.toString()
    case 'function':
      return `[Function ${value.name || 'anonymous'}]`
    case 'undefined':
      return undefined
    case 'object':
      break
  }
  if (value === null) return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
  }
  if (depth >= MAX_SERIALIZATION_DEPTH) return TRUNCATED_VALUE
  if (path.has(value)) return CIRCULAR_VALUE
  if (value instanceof Error) return serializeErrorAt(value, depth, 0, path)
  path.add(value)
  try {
    if (Array.isArray(value)) return value.map((item) => sanitizeAt(item, depth + 1, path))
    if (value instanceof Map) {
      const entries: Array<[string, unknown]> = []
      for (const [key, item] of value.entries()) entries.push([String(key), item])
      return sanitizeEntries(entries, depth, path)
    }
    if (value instanceof Set) return [...value].map((item) => sanitizeAt(item, depth + 1, path))
    const entries = readEntries(value)
    return entries === null ? UNSERIALIZABLE_VALUE : sanitizeEntries(entries, depth, path)
  } finally {
    path.delete(value)
  }
}

function sanitizeEntries(
  entries: ReadonlyArray<readonly [string, unknown]>,
  depth: number,
  path: Set<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, item] of entries) {
    if (item === undefined) continue
    if (isRedactedKey(key)) {
      out[key] = item === null ? null : REDACTED_VALUE
      continue
    }
    out[key] = sanitizeAt(item, depth + 1, path)
  }
  return out
}
