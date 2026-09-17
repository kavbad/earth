import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { type HumanId, isEarthError } from '@earth/domain'

import {
  type StartVerificationInput,
  VerificationConfigError,
  VerificationResultSchema,
  VerificationSessionSchema,
} from './types'
import {
  type FetchLike,
  type FetchRequestInit,
  MAX_SIGNATURE_CANDIDATES,
  VendorHumanVerificationProvider,
  constantTimeEqualHex,
  extractSignatureHex,
  extractSignatureHexes,
  hmacSha256Hex,
} from './vendor'

const HUMAN = '11111111-1111-4111-8111-111111111111' as HumanId
const OTHER_HUMAN = '22222222-2222-4222-8222-222222222222' as HumanId
const SECRET = 'whsec_test_secret_0123456789'
const BASE_URL = 'https://liveness.example.com/v1/'
const NOW = () => new Date('2026-09-03T10:00:00.000Z')

const INPUT: StartVerificationInput = {
  humanId: HUMAN,
  humanPassId: 'pass-3',
  locale: 'en-US',
  platform: 'android',
  returnUrl: 'https://earth.social/claim/return',
}

interface RecordedCall {
  url: string
  init: FetchRequestInit | undefined
}

interface CannedResponse {
  status: number
  body: unknown
}

function fakeFetch(responses: CannedResponse[]): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const queue = [...responses]
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init })
    const next = queue.shift()
    if (next === undefined) throw new Error(`unexpected fetch ${url}`)
    const text = typeof next.body === 'string' ? next.body : JSON.stringify(next.body)
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => text,
    }
  }
  return { fetch, calls }
}

function provider(
  fetch: FetchLike,
  extra: Partial<ConstructorParameters<typeof VendorHumanVerificationProvider>[0]> = {},
) {
  return new VendorHumanVerificationProvider({
    baseUrl: BASE_URL,
    apiKey: 'sk_test',
    webhookSecret: SECRET,
    fetch,
    now: NOW,
    ...extra,
  })
}

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

describe('VendorHumanVerificationProvider', () => {
  it('requires a base url and api key', () => {
    const { fetch } = fakeFetch([])
    expect(() => new VendorHumanVerificationProvider({ baseUrl: '', apiKey: 'k', fetch })).toThrow(
      VerificationConfigError,
    )
    expect(
      () => new VendorHumanVerificationProvider({ baseUrl: BASE_URL, apiKey: ' ', fetch }),
    ).toThrow(VerificationConfigError)
  })

  it('creates a hosted session with the api key and a privacy-minimal body', async () => {
    const { fetch, calls } = fakeFetch([
      {
        status: 201,
        body: {
          id: 'vs_1',
          url: 'https://liveness.example.com/go/vs_1',
          expires_at: '2026-09-03T10:30:00Z',
        },
      },
    ])
    const session = await provider(fetch).startVerification(INPUT)

    expect(VerificationSessionSchema.parse(session)).toEqual(session)
    expect(session).toEqual({
      sessionId: 'vs_1',
      provider: 'vendor',
      mode: 'hosted_url',
      url: 'https://liveness.example.com/go/vs_1',
      expiresAt: '2026-09-03T10:30:00.000Z',
    })
    expect(calls).toHaveLength(1)
    const call = calls[0]
    expect(call?.url).toBe('https://liveness.example.com/v1/sessions')
    expect(call?.init?.method).toBe('POST')
    expect(call?.init?.headers).toMatchObject({
      authorization: 'Bearer sk_test',
      'content-type': 'application/json',
    })
    expect(JSON.parse(call?.init?.body ?? '{}')).toEqual({
      subject_id: HUMAN,
      reference_id: 'pass-3',
      locale: 'en-US',
      platform: 'android',
      return_url: 'https://earth.social/claim/return',
    })
  })

  it('falls back to a default expiry when the vendor omits it', async () => {
    const { fetch } = fakeFetch([
      { status: 200, body: { id: 'vs_2', url: 'https://x.example/vs_2' } },
    ])
    const session = await provider(fetch).startVerification(INPUT)
    expect(session.expiresAt).toBe('2026-09-03T10:30:00.000Z')
  })

  it('throws internal when the vendor refuses or returns junk on create', async () => {
    const refused = fakeFetch([{ status: 500, body: 'boom' }])
    await expect(provider(refused.fetch).startVerification(INPUT)).rejects.toSatisfy(
      (error: unknown) => isEarthError(error) && error.code === 'internal',
    )
    const junk = fakeFetch([{ status: 200, body: { nope: true } }])
    await expect(provider(junk.fetch).startVerification(INPUT)).rejects.toSatisfy(
      (error: unknown) => isEarthError(error) && error.code === 'internal',
    )
  })

  it.each([
    ['approved', 'verified', null],
    ['pending', 'pending', null],
    ['processing', 'pending', null],
    ['declined', 'rejected', 'inconclusive'],
    ['needs_review', 'review_required', 'inconclusive'],
    ['inconclusive', 'inconclusive', 'inconclusive'],
    ['expired', 'error', 'technical'],
    ['something_new', 'error', 'technical'],
  ] as const)('normalizes vendor status %s → %s', async (vendorStatus, status, failureKind) => {
    const { fetch, calls } = fakeFetch([
      { status: 200, body: { id: 'vs_3', status: vendorStatus, risk: 'LOW', extra: { raw: 1 } } },
    ])
    const result = await provider(fetch).getVerificationResult('vs_3')

    expect(calls[0]?.url).toBe('https://liveness.example.com/v1/sessions/vs_3')
    expect(calls[0]?.init?.method).toBe('GET')
    expect(VerificationResultSchema.parse(result)).toEqual(result)
    expect(result.status).toBe(status)
    expect(result.failureKind ?? null).toBe(failureKind)
    expect(result.riskLevel).toBe('low')
    expect(result.providerReference).toBe('vs_3')
    // The raw vendor payload lives only under metadata.
    expect(result.metadata).toMatchObject({
      provider: 'vendor',
      vendorStatus,
      vendor: { id: 'vs_3', status: vendorStatus, extra: { raw: 1 } },
    })
    expect(Object.keys(result).sort()).toEqual(
      [
        'duplicateOfHumanId',
        'metadata',
        'providerReference',
        'riskLevel',
        'status',
        ...(failureKind ? ['failureKind'] : []),
      ].sort(),
    )
  })

  it('surfaces a duplicate as review_required pointing at the matched Human', async () => {
    const { fetch } = fakeFetch([
      {
        status: 200,
        body: { id: 'vs_4', status: 'duplicate', risk_level: 'high', duplicate_of: OTHER_HUMAN },
      },
    ])
    const result = await provider(fetch).getVerificationResult('vs_4')
    expect(result.status).toBe('review_required')
    expect(result.duplicateOfHumanId).toBe(OTHER_HUMAN)
    expect(result.failureKind).toBe('duplicate')
    expect(result.riskLevel).toBe('high')
  })

  it('keeps a foreign duplicate reference out of duplicateOfHumanId but still treats it as a duplicate', async () => {
    const { fetch } = fakeFetch([
      { status: 200, body: { id: 'vs_5', status: 'review', duplicate_of: 'vendor-x' } },
    ])
    const result = await provider(fetch).getVerificationResult('vs_5')
    expect(result.duplicateOfHumanId).toBeNull()
    expect(result.status).toBe('review_required')
    expect(result.failureKind).toBe('duplicate')
    expect(result.metadata).toMatchObject({ vendor: { duplicate_of: 'vendor-x' } })
  })

  it('never lets an "approved" result that matched another Human through as verified (spec §48, §128)', async () => {
    const { fetch } = fakeFetch([
      {
        status: 200,
        body: { id: 'vs_5a', status: 'approved', risk: 'low', duplicate_of: OTHER_HUMAN },
      },
      {
        status: 200,
        body: { id: 'vs_5b', status: 'pending', duplicate_of_subject: OTHER_HUMAN },
      },
    ])
    const p = provider(fetch)
    const approved = await p.getVerificationResult('vs_5a')
    expect(approved.status).toBe('review_required')
    expect(approved.failureKind).toBe('duplicate')
    expect(approved.duplicateOfHumanId).toBe(OTHER_HUMAN)
    expect(VerificationResultSchema.parse(approved)).toEqual(approved)
    const pending = await p.getVerificationResult('vs_5b')
    expect(pending.status).toBe('review_required')
    expect(pending.failureKind).toBe('duplicate')
  })

  it('reads a duplicate status word as "Recover your place" even without an id (spec §111)', async () => {
    const { fetch } = fakeFetch([
      { status: 200, body: { id: 'vs_5c', status: 'Duplicate' } },
      { status: 200, body: { id: 'vs_5d', status: 'already_enrolled' } },
      { status: 200, body: { id: 'vs_5e', status: 'twin' } },
    ])
    const p = provider(fetch, { duplicateStatuses: ['TWIN'] })
    for (const id of ['vs_5c', 'vs_5d', 'vs_5e']) {
      const result = await p.getVerificationResult(id)
      expect(result.status).toBe('review_required')
      expect(result.failureKind).toBe('duplicate')
      expect(result.duplicateOfHumanId).toBeNull()
    }
  })

  it('refuses a hosted url that is not http(s) (it is handed to the client verbatim)', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://x.example', 42, '']) {
      const { fetch } = fakeFetch([{ status: 200, body: { id: 'vs_bad', url } }])
      await expect(provider(fetch).startVerification(INPUT)).rejects.toSatisfy(
        (error: unknown) => isEarthError(error) && error.code === 'internal',
      )
    }
  })

  it('honours a per-vendor status map', async () => {
    const { fetch } = fakeFetch([{ status: 200, body: { id: 'vs_6', status: 'GREEN' } }])
    const result = await provider(fetch, {
      statusMap: { green: 'verified' },
    }).getVerificationResult('vs_6')
    expect(result.status).toBe('verified')
  })

  it('maps a 404 to invalid_input and other HTTP failures to a technical result', async () => {
    const missing = fakeFetch([{ status: 404, body: { error: 'not found' } }])
    await expect(provider(missing.fetch).getVerificationResult('vs_x')).rejects.toSatisfy(
      (error: unknown) => isEarthError(error) && error.code === 'invalid_input',
    )
    const down = fakeFetch([{ status: 503, body: 'try later' }])
    const result = await provider(down.fetch).getVerificationResult('vs_7')
    expect(result.status).toBe('error')
    expect(result.failureKind).toBe('technical')
    expect(result.metadata).toMatchObject({ httpStatus: 503 })

    const junk = fakeFetch([{ status: 200, body: 'not json' }])
    const malformed = await provider(junk.fetch).getVerificationResult('vs_8')
    expect(malformed.status).toBe('error')
    expect(malformed.metadata).toMatchObject({ reason: 'malformed_response' })
  })

  describe('verifyWebhook', () => {
    const body = JSON.stringify({
      event: 'session.completed',
      session: { id: 'vs_9', status: 'approved', risk: 'medium' },
    })

    it('accepts a body signed with the shared secret (bare hex, sha256= and v1= forms)', async () => {
      const { fetch } = fakeFetch([])
      const hex = sign(body)
      for (const header of [hex, hex.toUpperCase(), `sha256=${hex}`, `t=1725357600,v1=${hex}`]) {
        const event = await provider(fetch).verifyWebhook(body, header)
        expect(event.sessionId).toBe('vs_9')
        expect(event.result.status).toBe('verified')
        expect(event.result.riskLevel).toBe('medium')
        expect(event.result.metadata).toMatchObject({ vendor: { id: 'vs_9', status: 'approved' } })
      }
    })

    it('rejects a wrong secret, a tampered body, a missing header and garbage', async () => {
      const { fetch } = fakeFetch([])
      const p = provider(fetch)
      const forbidden = (error: unknown) => isEarthError(error) && error.code === 'forbidden'
      await expect(p.verifyWebhook(body, sign(body, 'other-secret'))).rejects.toSatisfy(forbidden)
      await expect(
        p.verifyWebhook(body.replace('approved', 'declined'), sign(body)),
      ).rejects.toSatisfy(forbidden)
      await expect(p.verifyWebhook(body, null)).rejects.toSatisfy(forbidden)
      await expect(p.verifyWebhook(body, 'not-hex')).rejects.toSatisfy(forbidden)
      await expect(p.verifyWebhook(body, sign(body).slice(0, 10))).rejects.toSatisfy(forbidden)
    })

    it('rejects a signed body that is not a session payload', async () => {
      const { fetch } = fakeFetch([])
      const junk = JSON.stringify({ hello: 'world' })
      await expect(provider(fetch).verifyWebhook(junk, sign(junk))).rejects.toSatisfy(
        (error: unknown) => isEarthError(error) && error.code === 'invalid_input',
      )
    })

    it('accepts flat and data-wrapped session bodies', async () => {
      const { fetch } = fakeFetch([])
      const flat = JSON.stringify({ id: 'vs_10', status: 'declined' })
      const wrapped = JSON.stringify({ data: { session_id: 'vs_11', status: 'pending' } })
      expect((await provider(fetch).verifyWebhook(flat, sign(flat))).result.status).toBe('rejected')
      const event = await provider(fetch).verifyWebhook(wrapped, sign(wrapped))
      expect(event.sessionId).toBe('vs_11')
      expect(event.result.status).toBe('pending')
    })

    it('is a configuration error without a webhook secret', async () => {
      const { fetch } = fakeFetch([])
      const p = provider(fetch, { webhookSecret: undefined })
      await expect(p.verifyWebhook(body, sign(body))).rejects.toThrow(VerificationConfigError)
      const blank = provider(fetch, { webhookSecret: '   ' })
      await expect(blank.verifyWebhook(body, sign(body, '   '))).rejects.toThrow(
        VerificationConfigError,
      )
    })

    it('accepts a header listing several signatures when any is right (secret rotation)', async () => {
      const { fetch } = fakeFetch([])
      const hex = sign(body)
      const forbidden = (error: unknown) => isEarthError(error) && error.code === 'forbidden'
      const event = await provider(fetch).verifyWebhook(body, `t=1,v1=zz,v1=${hex}`)
      expect(event.sessionId).toBe('vs_9')
      await expect(
        provider(fetch).verifyWebhook(body, `v1=${sign(body, 'old-secret')},v1=${hex}`),
      ).resolves.toBeDefined()
      await expect(
        provider(fetch).verifyWebhook(body, `v1=${hex},v1=${sign(body, 'old-secret')}`),
      ).resolves.toBeDefined()
      // Wrong signatures do not add up to a right one, however many are listed.
      const wrong = Array.from({ length: 20 }, (_, i) => `v1=${sign(body, `k${i}`)}`).join(',')
      await expect(provider(fetch).verifyWebhook(body, wrong)).rejects.toSatisfy(forbidden)
      // Beyond the candidate cap a correct signature is not even looked at (bounded work).
      await expect(provider(fetch).verifyWebhook(body, `${wrong},v1=${hex}`)).rejects.toSatisfy(
        forbidden,
      )
    })

    it('applies the duplicate rule to callbacks too', async () => {
      const { fetch } = fakeFetch([])
      const dup = JSON.stringify({
        session: { id: 'vs_12', status: 'approved', duplicate_of: OTHER_HUMAN },
      })
      const event = await provider(fetch).verifyWebhook(dup, sign(dup))
      expect(event.result.status).toBe('review_required')
      expect(event.result.failureKind).toBe('duplicate')
      expect(event.result.duplicateOfHumanId).toBe(OTHER_HUMAN)
    })

    it('does not parse the body before the signature is verified', async () => {
      const { fetch } = fakeFetch([])
      // Unsigned junk is refused as forbidden, not as malformed: the body was never inspected.
      await expect(provider(fetch).verifyWebhook('{not json', 'abcd')).rejects.toSatisfy(
        (error: unknown) => isEarthError(error) && error.code === 'forbidden',
      )
    })
  })
})

describe('signature helpers', () => {
  it('hmacSha256Hex matches node:crypto', async () => {
    const expected = createHmac('sha256', 'k').update('payload').digest('hex')
    expect(await hmacSha256Hex(globalThis.crypto.subtle, 'k', 'payload')).toBe(expected)
  })

  it('extractSignatureHex parses the supported header shapes', () => {
    expect(extractSignatureHex(null)).toBeNull()
    expect(extractSignatureHex('   ')).toBeNull()
    expect(extractSignatureHex('ABCD')).toBe('abcd')
    expect(extractSignatureHex('abc')).toBeNull()
    expect(extractSignatureHex('sha256=abcd')).toBe('abcd')
    expect(extractSignatureHex('t=1,v1=abcd,v0=ffff')).toBe('abcd')
    expect(extractSignatureHex('t=1,v0=ffff')).toBeNull()
  })

  it('extractSignatureHexes returns every usable candidate, capped', () => {
    expect(extractSignatureHexes(null)).toEqual([])
    expect(extractSignatureHexes('t=1,v1=abcd,v1=zz,v1=EF01,s=1234')).toEqual([
      'abcd',
      'ef01',
      '1234',
    ])
    const many = Array.from(
      { length: MAX_SIGNATURE_CANDIDATES + 5 },
      (_, i) => `v1=${(i + 16).toString(16).padStart(2, '0')}`,
    ).join(',')
    expect(extractSignatureHexes(many)).toHaveLength(MAX_SIGNATURE_CANDIDATES)
  })

  it('constantTimeEqualHex compares exact strings only', () => {
    expect(constantTimeEqualHex('abcd', 'abcd')).toBe(true)
    expect(constantTimeEqualHex('abcd', 'abce')).toBe(false)
    expect(constantTimeEqualHex('abcd', 'abcde')).toBe(false)
    expect(constantTimeEqualHex('abcde', 'abcd')).toBe(false)
    expect(constantTimeEqualHex('', 'a')).toBe(false)
    expect(constantTimeEqualHex('a', '')).toBe(false)
    expect(constantTimeEqualHex('', '')).toBe(true)
    // Prefix matches, suffix matches and case differences are all mismatches.
    const digest = sign('x')
    expect(constantTimeEqualHex(digest, digest)).toBe(true)
    expect(constantTimeEqualHex(digest, digest.slice(0, -1) + '0')).toBe(digest.endsWith('0'))
    expect(constantTimeEqualHex(digest, `0${digest.slice(1)}`)).toBe(digest.startsWith('0'))
    expect(constantTimeEqualHex(digest, digest.toUpperCase())).toBe(digest === digest.toUpperCase())
    for (let i = 0; i < 64; i += 1) {
      const flipped = digest.slice(0, i) + (digest[i] === 'f' ? '0' : 'f') + digest.slice(i + 1)
      expect(constantTimeEqualHex(digest, flipped)).toBe(false)
    }
  })
})
