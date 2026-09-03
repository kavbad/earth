/**
 * Feed cursor (ARCHITECTURE §9 step 3; spec §70). Opaque to clients: base64url of the JSON
 * `{ v: 1, snapshotAt, lastScore, lastId, scope, areaId }`. Keyset on `(score desc, id asc)`;
 * offset pagination is forbidden. Pure TypeScript encoding so it runs in Node, browsers and
 * React Native alike (no `Buffer`).
 */
import { z } from 'zod'

import { FEED_CURSOR_VERSION } from '../constants'
import { IsoDateTimeSchema } from '../dto/common'
import { ScopeSchema, type Scope } from '../enums'
import { EarthError } from '../errors'

export const FeedCursorSchema = z.object({
  v: z.literal(FEED_CURSOR_VERSION),
  snapshotAt: IsoDateTimeSchema,
  lastScore: z.number().min(0).max(1),
  lastId: z.string().min(1),
  scope: ScopeSchema,
  areaId: z.uuid().nullable(),
})
export type FeedCursor = z.infer<typeof FeedCursorSchema>

export type FeedCursorInput = Omit<FeedCursor, 'v'>

export interface ExpectedCursorContext {
  readonly scope: Scope
  /** When given, a cursor minted for another area is rejected. */
  readonly areaId?: string | null
}

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const BASE64URL_REGEX = /^[A-Za-z0-9_-]*$/

function utf8Encode(text: string): number[] {
  const bytes: number[] = []
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) bytes.push(code)
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return bytes
}

/**
 * Strict UTF-8 decode. Returns `null` for anything that is not well-formed UTF-8 (bad lead or
 * continuation bytes, truncated sequences, overlong forms, surrogates, code points above U+10FFFF).
 * Cursors are untrusted client input: a lenient decoder let a crafted byte sequence reach
 * `String.fromCodePoint` with an out-of-range value and throw a `RangeError` instead of the
 * `EarthError('invalid_input')` the contract promises.
 */
function utf8Decode(bytes: readonly number[]): string | null {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b0 = bytes[i] ?? 0
    let code: number
    let extra: number
    let min: number
    if (b0 < 0x80) {
      code = b0
      extra = 0
      min = 0
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      code = b0 & 0x1f
      extra = 1
      min = 0x80
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      code = b0 & 0x0f
      extra = 2
      min = 0x800
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      code = b0 & 0x07
      extra = 3
      min = 0x10000
    } else {
      return null
    }
    if (i + extra >= bytes.length) return null
    for (let k = 1; k <= extra; k++) {
      const b = bytes[i + k] ?? 0
      if ((b & 0xc0) !== 0x80) return null
      code = (code << 6) | (b & 0x3f)
    }
    if (code < min || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null
    out += String.fromCodePoint(code)
    i += extra + 1
  }
  return out
}

export function base64urlEncode(text: string): string {
  const bytes = utf8Encode(text)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    const triple = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0)
    out += ALPHABET[(triple >> 18) & 63] ?? ''
    out += ALPHABET[(triple >> 12) & 63] ?? ''
    if (b1 !== undefined) out += ALPHABET[(triple >> 6) & 63] ?? ''
    if (b2 !== undefined) out += ALPHABET[triple & 63] ?? ''
  }
  return out
}

/** Returns `null` for input that is not base64url or does not decode to well-formed UTF-8. Never throws. */
export function base64urlDecode(encoded: string): string | null {
  if (!BASE64URL_REGEX.test(encoded) || encoded.length % 4 === 1) return null
  const bytes: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of encoded) {
    buffer = (buffer << 6) | ALPHABET.indexOf(char)
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return utf8Decode(bytes)
}

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

export function encodeCursor(cursor: FeedCursorInput): string {
  const value: FeedCursor = {
    v: FEED_CURSOR_VERSION,
    snapshotAt: cursor.snapshotAt,
    lastScore: cursor.lastScore,
    lastId: cursor.lastId,
    scope: cursor.scope,
    areaId: cursor.areaId,
  }
  return base64urlEncode(JSON.stringify(value))
}

function invalid(reason: string): EarthError {
  return new EarthError('invalid_input', {
    details: { field: 'cursor', reason },
    message: `cursor: ${reason}`,
  })
}

/**
 * Decodes and validates a cursor. Throws `EarthError('invalid_input')` with
 * `details.reason` = `malformed` | `wrong_version` | `wrong_scope` | `wrong_area` | `invalid`.
 */
export function decodeCursor(raw: string, expected: ExpectedCursorContext): FeedCursor {
  const json = base64urlDecode(raw.trim())
  if (json === null) throw invalid('malformed')
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw invalid('malformed')
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalid('malformed')
  const version = (parsed as { v?: unknown }).v
  if (version !== FEED_CURSOR_VERSION) throw invalid('wrong_version')
  const result = FeedCursorSchema.safeParse(parsed)
  if (!result.success) throw invalid('invalid')
  const cursor = result.data
  if (cursor.scope !== expected.scope) throw invalid('wrong_scope')
  if (expected.areaId !== undefined && cursor.areaId !== (expected.areaId ?? null)) {
    throw invalid('wrong_area')
  }
  return cursor
}
