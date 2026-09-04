import { EarthError, type EarthErrorCode } from '@earth/domain'

import { earthCopy } from './copy'

/** The stable code of any failure (`internal` for anything that is not an `EarthError`). */
export function errorCode(error: unknown): EarthErrorCode {
  return error instanceof EarthError ? error.code : 'internal'
}

/** One line for a failed write: rate limits and malformed input get their own words. */
export function messageForError(error: unknown): string {
  switch (errorCode(error)) {
    case 'rate_limited':
      return earthCopy.tooManyTries
    case 'invalid_input':
      return earthCopy.checkAddress
    default:
      return earthCopy.somethingWrong
  }
}
