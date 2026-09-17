import { describe, expect, it } from 'vitest'

import { FEED_CURSOR_VERSION } from '../constants'
import { EarthError } from '../errors'
import {
  base64urlDecode,
  base64urlEncode,
  decodeCursor,
  encodeCursor,
  type FeedCursorInput,
} from './cursor'
import { seeded, uuidAt } from './fixtures'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** base64url of raw bytes (the production encoder only takes text). */
function b64(bytes: readonly number[]): string {
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

const input: FeedCursorInput = {
  snapshotAt: '2026-09-03T12:00:00.000Z',
  lastScore: 0.4321,
  lastId: uuidAt(42),
  scope: 'friends',
  areaId: null,
}

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    if (error instanceof EarthError) return error.details?.['reason'] as string | undefined
    throw error
  }
  return undefined
}

describe('base64url', () => {
  it('round-trips ASCII and unicode without padding characters', () => {
    for (const text of ['', 'a', 'ab', 'abc', '{"v":1}', 'Weekend Crew 🌍 — café']) {
      const encoded = base64urlEncode(text)
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/)
      expect(base64urlDecode(encoded)).toBe(text)
    }
    expect(base64urlEncode('hi?')).toBe('aGk_')
  })

  it('rejects non-base64url input', () => {
    expect(base64urlDecode('not valid!')).toBeNull()
    expect(base64urlDecode('a')).toBeNull()
  })

  it('returns null for malformed UTF-8 instead of throwing', () => {
    // ff bf bf bf: a lead byte outside UTF-8 used to reach String.fromCodePoint → RangeError.
    expect(base64urlDecode('_7-_vw')).toBeNull()
    expect(base64urlDecode(b64([0xf7, 0xbf, 0xbf, 0xbf]))).toBeNull() // > U+10FFFF
    expect(base64urlDecode(b64([0xe2, 0x82]))).toBeNull() // truncated 3-byte sequence
    expect(base64urlDecode(b64([0x80]))).toBeNull() // lone continuation byte
    expect(base64urlDecode(b64([0xc0, 0xaf]))).toBeNull() // overlong "/"
    expect(base64urlDecode(b64([0xed, 0xa0, 0x80]))).toBeNull() // UTF-16 surrogate
    expect(base64urlDecode(b64([0x41, 0xc3, 0xa9]))).toBe('Aé') // well-formed still decodes
  })

  it('never throws on arbitrary bytes', () => {
    const rand = seeded(5)
    for (let trial = 0; trial < 1000; trial++) {
      const bytes = Array.from({ length: Math.floor(rand() * 12) }, () => Math.floor(rand() * 256))
      expect(() => base64urlDecode(b64(bytes))).not.toThrow()
    }
  })
})

describe('feed cursor (ARCHITECTURE §9)', () => {
  it('round-trips through base64url JSON with version 1', () => {
    const encoded = encodeCursor(input)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(JSON.parse(base64urlDecode(encoded) ?? '')).toEqual({ v: FEED_CURSOR_VERSION, ...input })
    expect(decodeCursor(encoded, { scope: 'friends' })).toEqual({ v: 1, ...input })
    expect(decodeCursor(` ${encoded} `, { scope: 'friends', areaId: null })).toEqual({
      v: 1,
      ...input,
    })
  })

  it('keeps the area id', () => {
    const area = uuidAt(9)
    const encoded = encodeCursor({ ...input, scope: 'city', areaId: area })
    expect(decodeCursor(encoded, { scope: 'city', areaId: area }).areaId).toBe(area)
    expect(reasonOf(() => decodeCursor(encoded, { scope: 'city', areaId: uuidAt(10) }))).toBe(
      'wrong_area',
    )
    expect(reasonOf(() => decodeCursor(encoded, { scope: 'city', areaId: null }))).toBe(
      'wrong_area',
    )
    expect(decodeCursor(encoded, { scope: 'city' }).areaId).toBe(area)
  })

  it('rejects malformed, wrong version, wrong scope and invalid payloads', () => {
    expect(reasonOf(() => decodeCursor('***', { scope: 'friends' }))).toBe('malformed')
    // Crafted bytes that are valid base64url but not UTF-8 are `malformed`, never a RangeError.
    expect(reasonOf(() => decodeCursor('_7-_vw', { scope: 'friends' }))).toBe('malformed')
    expect(reasonOf(() => decodeCursor(base64urlEncode('{not json'), { scope: 'friends' }))).toBe(
      'malformed',
    )
    expect(reasonOf(() => decodeCursor(base64urlEncode('"string"'), { scope: 'friends' }))).toBe(
      'malformed',
    )
    expect(
      reasonOf(() =>
        decodeCursor(base64urlEncode(JSON.stringify({ ...input, v: 2 })), { scope: 'friends' }),
      ),
    ).toBe('wrong_version')
    expect(reasonOf(() => decodeCursor(encodeCursor(input), { scope: 'world' }))).toBe(
      'wrong_scope',
    )
    expect(
      reasonOf(() =>
        decodeCursor(base64urlEncode(JSON.stringify({ ...input, v: 1, lastScore: 7 })), {
          scope: 'friends',
        }),
      ),
    ).toBe('invalid')
    expect(
      reasonOf(() =>
        decodeCursor(base64urlEncode(JSON.stringify({ ...input, v: 1, lastId: '' })), {
          scope: 'friends',
        }),
      ),
    ).toBe('invalid')
    expect(
      reasonOf(() =>
        decodeCursor(base64urlEncode(JSON.stringify({ ...input, v: 1, snapshotAt: 'yesterday' })), {
          scope: 'friends',
        }),
      ),
    ).toBe('invalid')
  })

  it('errors are EarthError invalid_input', () => {
    try {
      decodeCursor('***', { scope: 'friends' })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(EarthError)
      expect((error as EarthError).code).toBe('invalid_input')
    }
  })
})
