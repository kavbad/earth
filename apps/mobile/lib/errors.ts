import { EarthError, type EarthErrorCode } from '@earth/domain'

/** The stable code of any failure (`internal` for anything that is not an `EarthError`). */
export function errorCode(error: unknown): EarthErrorCode {
  return error instanceof EarthError ? error.code : 'internal'
}
