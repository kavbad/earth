import { EarthError, type EarthErrorCode } from '@earth/domain'

/** The stable code of any failure (`internal` for anything that is not an `EarthError`). */
export function errorCode(error: unknown): EarthErrorCode {
  return error instanceof EarthError ? error.code : 'internal'
}

/**
 * Codes that mean "try again in a moment", not "this is gone" (spec §107, §110). A dropped
 * connection, a timeout and anything that is not an `EarthError` all arrive as `internal`; a
 * throttled call arrives as `rate_limited`. Every other code is the server's settled answer
 * about the thing that was asked for — a dead invite, an ended room, content the viewer may not
 * see — and is stated plainly instead of offering a pointless retry.
 */
export const TRANSIENT_ERROR_CODES = ['internal', 'rate_limited'] as const

export function isTransientFailure(code: EarthErrorCode): boolean {
  return (TRANSIENT_ERROR_CODES as readonly EarthErrorCode[]).includes(code)
}
