/**
 * Machine error codes raised by RPCs (`raise exception using errcode = 'P0001',
 * message = '<code>'`, ARCHITECTURE §5) and by the server tier. The code list is the contract;
 * copy for humans lives in `@earth/ui`.
 */

export const EARTH_ERROR_CODES = [
  'not_authenticated',
  'not_a_human',
  'human_not_active',
  'claim_not_pending',
  'claim_identity_missing',
  'verification_required',
  'verification_pending',
  'duplicate_human',
  'handle_taken',
  'handle_invalid',
  'group_not_found',
  'not_a_member',
  'not_a_moderator',
  'invite_invalid',
  'invite_expired',
  'invite_exhausted',
  'conversation_not_found',
  'blocked',
  'rate_limited',
  'message_not_found',
  'room_not_found',
  'room_ended',
  'not_in_room',
  'consent_required',
  'join_not_allowed',
  'guest_not_allowed',
  'guests_disabled',
  'visibility_not_allowed',
  'post_not_found',
  'audience_too_wide',
  'reply_not_allowed',
  'not_visible',
  'area_not_found',
  'location_sharing_disabled',
  'feature_disabled',
  'invalid_input',
  'forbidden',
  'internal',
] as const

export type EarthErrorCode = (typeof EARTH_ERROR_CODES)[number]

const CODE_SET: ReadonlySet<string> = new Set<string>(EARTH_ERROR_CODES)

export function isEarthErrorCode(value: unknown): value is EarthErrorCode {
  return typeof value === 'string' && CODE_SET.has(value)
}

export type EarthErrorDetails = Readonly<Record<string, unknown>>

export interface EarthErrorOptions {
  details?: EarthErrorDetails
  cause?: unknown
  /** Human-readable message for logs; never shown to users as-is. Defaults to the code. */
  message?: string
}

export class EarthError extends Error {
  override readonly name = 'EarthError' as const
  readonly code: EarthErrorCode
  readonly details: EarthErrorDetails | undefined

  constructor(code: EarthErrorCode, options: EarthErrorOptions = {}) {
    super(
      options.message ?? code,
      options.cause === undefined ? undefined : { cause: options.cause },
    )
    this.code = code
    this.details = options.details
  }

  /** JSON shape used by the server tier (`{ error: { code, details } }`). */
  toJSON(): { code: EarthErrorCode; details?: EarthErrorDetails } {
    return this.details === undefined
      ? { code: this.code }
      : { code: this.code, details: this.details }
  }
}

export function isEarthError(value: unknown): value is EarthError {
  return value instanceof EarthError
}

/** Postgres SQLSTATE used by every `raise exception` in Earth RPCs. */
export const EARTH_RPC_SQLSTATE = 'P0001' as const

/** HTTP status the server tier answers with for each code (also used by clients for retries). */
export const EARTH_ERROR_HTTP_STATUS: Readonly<Record<EarthErrorCode, number>> = {
  not_authenticated: 401,
  not_a_human: 403,
  human_not_active: 403,
  claim_not_pending: 409,
  claim_identity_missing: 409,
  verification_required: 403,
  verification_pending: 409,
  duplicate_human: 409,
  handle_taken: 409,
  handle_invalid: 400,
  group_not_found: 404,
  not_a_member: 403,
  not_a_moderator: 403,
  invite_invalid: 404,
  invite_expired: 410,
  invite_exhausted: 410,
  conversation_not_found: 404,
  blocked: 403,
  rate_limited: 429,
  message_not_found: 404,
  room_not_found: 404,
  room_ended: 410,
  not_in_room: 403,
  consent_required: 409,
  join_not_allowed: 403,
  guest_not_allowed: 403,
  guests_disabled: 403,
  visibility_not_allowed: 403,
  post_not_found: 404,
  audience_too_wide: 400,
  reply_not_allowed: 403,
  not_visible: 404,
  area_not_found: 404,
  location_sharing_disabled: 403,
  feature_disabled: 403,
  invalid_input: 400,
  forbidden: 403,
  internal: 500,
}

export function httpStatusForErrorCode(code: EarthErrorCode): number {
  return EARTH_ERROR_HTTP_STATUS[code]
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function detailsFrom(record: Record<string, unknown>): EarthErrorDetails | undefined {
  const details = record['details']
  if (typeof details === 'object' && details !== null && !Array.isArray(details)) {
    return details as EarthErrorDetails
  }
  if (typeof details === 'string' && details.length > 0) {
    return { detail: details }
  }
  return undefined
}

/**
 * Maps any thrown value into an `EarthError`.
 *
 * Recognized inputs:
 * - an `EarthError` (returned as-is);
 * - a Postgres/PostgREST error whose `message` equals a known code (`raise exception ...
 *   message = 'not_a_member'`), optionally with `code = 'P0001'` and `details`/`hint`;
 * - a server-tier JSON body `{ error: { code, details } }` or `{ code, details }`;
 * - a bare string equal to a known code.
 *
 * Anything else becomes `EarthError('internal')` with the original value as `cause`.
 */
export function parseEarthError(value: unknown): EarthError {
  if (isEarthError(value)) return value

  if (typeof value === 'string') {
    const code = value.trim()
    return isEarthErrorCode(code)
      ? new EarthError(code)
      : new EarthError('internal', { cause: value, message: value })
  }

  const record = asRecord(value)
  if (record === undefined) {
    return new EarthError('internal', { cause: value })
  }

  const nested = asRecord(record['error'])
  const nestedCode = nested === undefined ? undefined : readString(nested, 'code')
  if (nested !== undefined && isEarthErrorCode(nestedCode)) {
    const details = detailsFrom(nested)
    return new EarthError(
      nestedCode,
      details === undefined ? { cause: value } : { details, cause: value },
    )
  }

  const message = readString(record, 'message')?.trim()
  if (isEarthErrorCode(message)) {
    const details = detailsFrom(record)
    return new EarthError(
      message,
      details === undefined ? { cause: value } : { details, cause: value },
    )
  }

  const code = readString(record, 'code')?.trim()
  if (isEarthErrorCode(code)) {
    const details = detailsFrom(record)
    return new EarthError(
      code,
      details === undefined ? { cause: value } : { details, cause: value },
    )
  }

  return new EarthError('internal', {
    cause: value,
    message: message !== undefined && message.length > 0 ? message : 'internal',
  })
}
