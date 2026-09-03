import { type ClaimStateDto, EarthError, VerificationSessionDtoSchema } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import {
  VerificationResultDtoSchema,
  handleVerificationResult,
  handleVerificationStart,
  handleVerificationWebhook,
  humanIdFromWebhookResult,
} from './verification'
import { mapError } from '../http'
import {
  FakeRpcFailure,
  TEST_HUMAN_ID,
  TEST_NOW,
  createFakeDeps,
  fakeRequest,
  rpcFailure,
  withoutWebhook,
} from '../test/fakes'
import type { VerificationResult } from '../verification/provider-types'

const PASS_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_HUMAN = '99999999-9999-4999-8999-999999999999'

interface ClaimDb {
  sessionId: string | undefined
  passStatus: ClaimStateDto['verification']['status']
  recorded: Record<string, unknown>[]
}

/** RPC handlers that behave like the identity migration: record_result updates the session anchor. */
function claimRpc(
  db: ClaimDb,
  options: { beginIncludesHumanId?: boolean; beginStatus?: string } = {},
) {
  const claimState = (): ClaimStateDto =>
    ({
      status: 'verifying',
      intent: 'start_group',
      groupLabel: 'Weekend Crew',
      identity: { displayName: 'Xavier', handle: 'xavier', avatarUrl: null },
      verification:
        db.sessionId === undefined
          ? { status: db.passStatus }
          : { status: db.passStatus, sessionId: db.sessionId },
      humanId: TEST_HUMAN_ID,
    }) as ClaimStateDto
  return {
    claim_verification_begin: () => ({
      humanPassId: PASS_ID,
      status: options.beginStatus ?? 'verifying',
      ...(options.beginIncludesHumanId === false ? {} : { humanId: TEST_HUMAN_ID }),
    }),
    claim_get: () => claimState(),
    human_pass_record_result: (args: Readonly<Record<string, unknown>>) => {
      db.recorded.push({ ...args })
      db.sessionId =
        typeof args['provider_reference'] === 'string' ? args['provider_reference'] : db.sessionId
      db.passStatus = args['status'] as ClaimDb['passStatus']
      return claimState()
    },
  }
}

function newDb(): ClaimDb {
  return { sessionId: undefined, passStatus: 'unverified', recorded: [] }
}

describe('handleVerificationStart', () => {
  it('requires a bearer', async () => {
    const { deps } = createFakeDeps()
    await expect(
      handleVerificationStart(
        deps,
        fakeRequest({ method: 'POST', url: '/api/claim/verification/start' }),
      ),
    ).rejects.toMatchObject({ code: 'not_authenticated' })
  })

  it('begins as the caller, starts the provider session and (mock) records the result immediately', async () => {
    const db = newDb()
    const { deps, supabase, verification } = createFakeDeps({ rpc: claimRpc(db) })
    const res = await handleVerificationStart(
      deps,
      fakeRequest({
        method: 'POST',
        url: '/x',
        bearer: 'jwt',
        body: { locale: 'en-US', platform: 'ios' },
      }),
    )
    expect(res.status).toBe(200)
    const dto = VerificationSessionDtoSchema.parse(res.body)
    expect(dto).toEqual({
      sessionId: 'fake-session-1',
      status: 'verified',
      providerUrl: null,
      expiresAt: '2026-09-03T12:15:00.000Z',
    })
    expect(Object.keys(res.body as object)).not.toContain('metadata')

    expect(supabase.callsTo('claim_verification_begin')[0]).toMatchObject({
      client: 'user:jwt',
      args: { provider: 'mock' },
    })
    expect(verification.starts[0]).toEqual({
      humanId: TEST_HUMAN_ID,
      humanPassId: PASS_ID,
      locale: 'en-US',
      platform: 'ios',
    })
    // 1. session anchor (verifying, provider_reference = session id) 2. the result.
    expect(db.recorded).toHaveLength(2)
    expect(db.recorded[0]).toMatchObject({
      human_id: TEST_HUMAN_ID,
      status: 'verifying',
      provider: 'mock',
      provider_reference: 'fake-session-1',
      duplicate_of_human_id: null,
    })
    expect(db.recorded[1]).toMatchObject({
      human_id: TEST_HUMAN_ID,
      status: 'verified',
      risk_level: 'low',
      provider: 'mock',
      provider_reference: 'fake-session-1',
      duplicate_of_human_id: null,
      metadata: {
        provider: 'fake',
        secret: 'never-shown',
        sessionId: 'fake-session-1',
        providerReference: 'ref:fake-session-1',
        resultStatus: 'verified',
        failureKind: null,
        recordedAt: TEST_NOW.toISOString(),
      },
    })
    expect(supabase.callsTo('human_pass_record_result').every((c) => c.client === 'admin')).toBe(
      true,
    )
    // begin carried humanId → no claim_get round trip needed.
    expect(supabase.callsTo('claim_get')).toHaveLength(0)
  })

  it('falls back to claim_get for the human id and passes returnUrl/hint through', async () => {
    const db = newDb()
    const { deps, supabase, verification } = createFakeDeps({
      rpc: claimRpc(db, { beginIncludesHumanId: false }),
    })
    await handleVerificationStart(
      deps,
      fakeRequest({
        method: 'POST',
        url: '/x',
        bearer: 'jwt',
        body: { returnUrl: 'https://earth.social/claim', hint: 'duplicate' },
      }),
    )
    expect(supabase.callsTo('claim_get')).toHaveLength(1)
    expect(verification.starts[0]).toMatchObject({
      humanId: TEST_HUMAN_ID,
      returnUrl: 'https://earth.social/claim',
      hint: 'duplicate',
      locale: 'en-US',
      platform: 'web',
    })
  })

  it('a duplicate outcome records review_required with the duplicate Human and reports failureKind duplicate', async () => {
    const db = newDb()
    const { deps, verification } = createFakeDeps({ rpc: claimRpc(db) })
    verification.resultFor = (sessionId) => ({
      status: 'review_required',
      riskLevel: 'high',
      providerReference: `ref:${sessionId}`,
      duplicateOfHumanId: OTHER_HUMAN as VerificationResult['duplicateOfHumanId'],
      metadata: { provider: 'fake', outcome: 'duplicate' },
      failureKind: 'duplicate',
    })
    const start = VerificationSessionDtoSchema.parse(
      (
        await handleVerificationStart(
          deps,
          fakeRequest({ method: 'POST', url: '/x', bearer: 'jwt' }),
        )
      ).body,
    )
    expect(start.status).toBe('review_required')
    expect(db.recorded[1]).toMatchObject({
      status: 'review_required',
      risk_level: 'high',
      duplicate_of_human_id: OTHER_HUMAN,
    })

    const result = VerificationResultDtoSchema.parse(
      (
        await handleVerificationResult(
          deps,
          fakeRequest({ url: '/x', bearer: 'jwt' }),
          start.sessionId,
        )
      ).body,
    )
    expect(result).toEqual({
      sessionId: 'fake-session-1',
      status: 'review_required',
      failureKind: 'duplicate',
    })
  })

  it('hosted providers return the provider url and stay verifying', async () => {
    const db = newDb()
    const { deps, verification } = createFakeDeps({ rpc: claimRpc(db) })
    verification.mode = 'hosted_url'
    verification.url = 'https://verify.example.com/s/1'
    const dto = VerificationSessionDtoSchema.parse(
      (
        await handleVerificationStart(
          deps,
          fakeRequest({ method: 'POST', url: '/x', bearer: 'jwt' }),
        )
      ).body,
    )
    expect(dto).toEqual({
      sessionId: 'fake-session-1',
      status: 'verifying',
      providerUrl: 'https://verify.example.com/s/1',
      expiresAt: '2026-09-03T12:15:00.000Z',
    })
    expect(db.recorded).toHaveLength(1)
    expect(verification.resultReads).toHaveLength(0)
  })

  it('an already verified pass short-circuits without starting a session', async () => {
    const db = { ...newDb(), sessionId: 'old-session', passStatus: 'verified' as const }
    const { deps, verification } = createFakeDeps({
      rpc: claimRpc(db, { beginStatus: 'verified' }),
    })
    const dto = VerificationSessionDtoSchema.parse(
      (
        await handleVerificationStart(
          deps,
          fakeRequest({ method: 'POST', url: '/x', bearer: 'jwt' }),
        )
      ).body,
    )
    expect(dto).toEqual({
      sessionId: 'old-session',
      status: 'verified',
      providerUrl: null,
      expiresAt: null,
    })
    expect(verification.starts).toHaveLength(0)
  })

  it('rejects invalid input and surfaces claim errors', async () => {
    const db = newDb()
    const { deps } = createFakeDeps({ rpc: claimRpc(db) })
    await expect(
      handleVerificationStart(
        deps,
        fakeRequest({ method: 'POST', url: '/x', bearer: 'jwt', body: { platform: 'blackberry' } }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    const notClaiming = createFakeDeps({
      rpc: {
        claim_verification_begin: () => {
          throw rpcFailure('claim_not_pending')
        },
      },
    })
    await expect(
      handleVerificationStart(
        notClaiming.deps,
        fakeRequest({ method: 'POST', url: '/x', bearer: 'jwt' }),
      ),
    ).rejects.toMatchObject({ code: 'claim_not_pending' })
  })
})

describe('handleVerificationResult', () => {
  it("requires a bearer and refuses sessions that are not the caller's", async () => {
    const db = { ...newDb(), sessionId: 'fake-session-1', passStatus: 'verifying' as const }
    const { deps, verification } = createFakeDeps({ rpc: claimRpc(db) })
    await expect(
      handleVerificationResult(deps, fakeRequest({ url: '/x' }), 'fake-session-1'),
    ).rejects.toMatchObject({ code: 'not_authenticated' })
    await expect(
      handleVerificationResult(deps, fakeRequest({ url: '/x', bearer: 'jwt' }), 'someone-elses'),
    ).rejects.toMatchObject({ code: 'not_visible' })
    await expect(
      handleVerificationResult(deps, fakeRequest({ url: '/x', bearer: 'jwt' }), ''),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(verification.resultReads).toHaveLength(0)
    expect(db.recorded).toHaveLength(0)
  })

  it('fetches, records and answers status + failureKind only; recording twice is fine', async () => {
    const db = { ...newDb(), sessionId: 'fake-session-1', passStatus: 'verifying' as const }
    const { deps, verification } = createFakeDeps({ rpc: claimRpc(db) })
    verification.resultFor = (sessionId) => ({
      status: 'inconclusive',
      riskLevel: 'medium',
      providerReference: `ref:${sessionId}`,
      duplicateOfHumanId: null,
      metadata: { provider: 'fake', internal: 'never' },
      failureKind: 'inconclusive',
    })
    const first = await handleVerificationResult(
      deps,
      fakeRequest({ url: '/x', bearer: 'jwt' }),
      'fake-session-1',
    )
    const second = await handleVerificationResult(
      deps,
      fakeRequest({ url: '/x', bearer: 'jwt' }),
      'fake-session-1',
    )
    for (const res of [first, second]) {
      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        sessionId: 'fake-session-1',
        status: 'review_required',
        failureKind: 'inconclusive',
      })
      expect(JSON.stringify(res.body)).not.toContain('never')
    }
    expect(db.recorded).toHaveLength(2)
    expect(db.recorded[0]).toEqual(db.recorded[1])
    expect(db.recorded[0]).toMatchObject({
      status: 'review_required',
      risk_level: 'medium',
      provider_reference: 'fake-session-1',
      duplicate_of_human_id: null,
    })
  })

  it('maps pending, technical error and rejected results', async () => {
    const db = { ...newDb(), sessionId: 'fake-session-1', passStatus: 'verifying' as const }
    const { deps, verification } = createFakeDeps({ rpc: claimRpc(db) })
    const base = { riskLevel: null, providerReference: 'r', duplicateOfHumanId: null, metadata: {} }
    const expectations: [VerificationResult, { status: string; failureKind: string | null }][] = [
      [
        { ...base, status: 'pending' },
        { status: 'verifying', failureKind: null },
      ],
      [
        { ...base, status: 'error' },
        { status: 'unverified', failureKind: 'technical' },
      ],
      [
        { ...base, status: 'rejected' },
        { status: 'rejected', failureKind: 'inconclusive' },
      ],
      [
        { ...base, status: 'verified', riskLevel: 'low' },
        { status: 'verified', failureKind: null },
      ],
    ]
    for (const [result, expected] of expectations) {
      verification.results.set('fake-session-1', result)
      const res = await handleVerificationResult(
        deps,
        fakeRequest({ url: '/x', bearer: 'jwt' }),
        'fake-session-1',
      )
      expect(res.body).toMatchObject(expected)
      db.passStatus = 'verifying'
    }
  })
})

describe('handleVerificationWebhook', () => {
  it('is refused for providers without callbacks', async () => {
    const db = newDb()
    const fake = createFakeDeps({ rpc: claimRpc(db) })
    const { deps } = createFakeDeps({
      rpc: claimRpc(db),
      verification: withoutWebhook(fake.verification),
    })
    const res = await handleVerificationWebhook(
      deps,
      fakeRequest({ method: 'POST', url: '/x', body: '{}' }),
    )
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ error: { code: 'feature_disabled' } })
  })

  it('verifies the signature, maps the Human from the vendor payload and records', async () => {
    const db = newDb()
    const { deps, verification } = createFakeDeps({ rpc: claimRpc(db) })
    verification.webhookHandler = (rawBody, signature) => {
      if (signature !== 'sig-ok') throw Object.assign(new Error('bad'), { code: 'forbidden' })
      const payload = JSON.parse(rawBody) as { id: string; subject_id: string }
      return {
        sessionId: payload.id,
        result: {
          status: 'verified',
          riskLevel: 'low',
          providerReference: payload.id,
          duplicateOfHumanId: null,
          metadata: { vendor: payload },
        },
      }
    }
    const body = JSON.stringify({ id: 'vendor-1', subject_id: TEST_HUMAN_ID, status: 'approved' })
    const res = await handleVerificationWebhook(
      deps,
      fakeRequest({ method: 'POST', url: '/x', headers: { 'x-signature': 'sig-ok' }, body }),
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, recorded: true, sessionId: 'vendor-1' })
    expect(db.recorded[0]).toMatchObject({
      human_id: TEST_HUMAN_ID,
      status: 'verified',
      provider_reference: 'vendor-1',
    })
    expect(verification.webhooks[0]).toEqual({ rawBody: body, signature: 'sig-ok' })

    const rejected = await handleVerificationWebhook(
      deps,
      fakeRequest({ method: 'POST', url: '/x', headers: { 'x-signature': 'nope' }, body }),
    ).catch((e: unknown) => e)
    expect(rejected).toMatchObject({ message: 'bad' })
  })

  it('accepts but does not record a callback whose Human cannot be identified', async () => {
    const db = newDb()
    const { deps, verification, logs } = createFakeDeps({ rpc: claimRpc(db) })
    verification.webhookHandler = () => ({
      sessionId: 'vendor-2',
      result: {
        status: 'verified',
        riskLevel: null,
        providerReference: 'vendor-2',
        duplicateOfHumanId: null,
        metadata: {},
      },
    })
    const res = await handleVerificationWebhook(
      deps,
      fakeRequest({ method: 'POST', url: '/x', body: '{}' }),
    )
    expect(res.status).toBe(202)
    expect(res.body).toEqual({
      ok: true,
      recorded: false,
      sessionId: 'vendor-2',
      reason: 'human_not_identified',
    })
    expect(db.recorded).toHaveLength(0)
    expect(logs.records.some((r) => r.msg === 'verification.webhook_unmapped')).toBe(true)
  })

  it('humanIdFromWebhookResult reads the subject from the known places only', () => {
    const base: VerificationResult = {
      status: 'verified',
      riskLevel: null,
      providerReference: 'x',
      metadata: {},
    }
    expect(humanIdFromWebhookResult(base)).toBeNull()
    expect(
      humanIdFromWebhookResult({ ...base, metadata: { vendor: { subject_id: TEST_HUMAN_ID } } }),
    ).toBe(TEST_HUMAN_ID)
    expect(humanIdFromWebhookResult({ ...base, metadata: { humanId: TEST_HUMAN_ID } })).toBe(
      TEST_HUMAN_ID,
    )
    expect(
      humanIdFromWebhookResult({ ...base, metadata: { vendor: { subject_id: 'not-a-uuid' } } }),
    ).toBeNull()
  })
})

describe('adversarial: verification responses never carry provider metadata', () => {
  const SECRET_MARKERS = ['never-shown', 'internal-only', 'ref:', OTHER_HUMAN, 'vendor-secret']

  function duplicateResult(sessionId: string): VerificationResult {
    return {
      status: 'review_required',
      riskLevel: 'high',
      providerReference: `ref:${sessionId}`,
      duplicateOfHumanId: OTHER_HUMAN as VerificationResult['duplicateOfHumanId'],
      metadata: {
        provider: 'fake',
        secret: 'never-shown',
        raw: { faces: ['internal-only'], subject: OTHER_HUMAN },
      },
      failureKind: 'duplicate',
    }
  }

  it('start (mock, duplicate outcome), result and webhook bodies contain no metadata', async () => {
    const db = newDb()
    const { deps, verification } = createFakeDeps({ rpc: claimRpc(db) })
    verification.resultFor = duplicateResult
    const start = await handleVerificationStart(
      deps,
      fakeRequest({ method: 'POST', url: '/x', bearer: 'jwt', body: {} }),
    )
    const result = await handleVerificationResult(
      deps,
      fakeRequest({ url: '/x', bearer: 'jwt' }),
      'fake-session-1',
    )
    verification.webhookHandler = (rawBody) => ({
      sessionId: (JSON.parse(rawBody) as { id: string }).id,
      result: {
        ...duplicateResult('vendor-1'),
        metadata: { vendor: { subject_id: TEST_HUMAN_ID, token: 'vendor-secret' } },
      },
    })
    const webhook = await handleVerificationWebhook(
      deps,
      fakeRequest({
        method: 'POST',
        url: '/x',
        headers: { 'x-signature': 'sig' },
        body: JSON.stringify({ id: 'vendor-1' }),
      }),
    )
    for (const res of [start, result, webhook]) {
      expect(res.status).toBeLessThan(300)
      const json = JSON.stringify(res.body)
      for (const marker of SECRET_MARKERS) expect(json, marker).not.toContain(marker)
      expect(Object.keys(res.body as object)).not.toContain('metadata')
    }
    expect(result.body).toEqual({
      sessionId: 'fake-session-1',
      status: 'review_required',
      failureKind: 'duplicate',
    })
    // Everything private went to the service RPC, and only there.
    expect(db.recorded.some((r) => JSON.stringify(r).includes('never-shown'))).toBe(true)
  })

  it('a failing record RPC keeps its code but never echoes Postgres details to the caller', async () => {
    const db = { ...newDb(), sessionId: 'fake-session-1', passStatus: 'verifying' as const }
    const handlers = claimRpc(db)
    const { deps } = createFakeDeps({
      rpc: {
        ...handlers,
        human_pass_record_result: () => {
          throw new FakeRpcFailure({
            message: 'duplicate_human',
            code: 'P0001',
            details: `duplicate of ${OTHER_HUMAN}`,
            hint: 'internal-only',
          })
        },
      },
    })
    const err = await handleVerificationResult(
      deps,
      fakeRequest({ url: '/x', bearer: 'jwt' }),
      'fake-session-1',
    ).catch((e: unknown) => e)
    const res = mapError(err)
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: { code: 'duplicate_human' } })
    const json = JSON.stringify(res.body)
    expect(json).not.toContain(OTHER_HUMAN)
    expect(json).not.toContain('internal-only')
  })

  it("the result route cannot be used to read another Human's session, whatever the id looks like", async () => {
    const db = { ...newDb(), sessionId: 'fake-session-1', passStatus: 'verifying' as const }
    const { deps, verification } = createFakeDeps({ rpc: claimRpc(db) })
    verification.results.set('fake-session-2', duplicateResult('fake-session-2'))
    for (const id of ['fake-session-2', 'FAKE-SESSION-1', ' fake-session-1', 'fake-session-1 ']) {
      await expect(
        handleVerificationResult(deps, fakeRequest({ url: '/x', bearer: 'jwt' }), id),
      ).rejects.toMatchObject({ code: 'not_visible' })
    }
    expect(verification.resultReads).toHaveLength(0)
    expect(db.recorded).toHaveLength(0)
  })

  it('a webhook with a bad signature is refused with the provider error and records nothing', async () => {
    const db = newDb()
    const { deps, verification } = createFakeDeps({ rpc: claimRpc(db) })
    verification.webhookHandler = () => {
      throw new EarthError('forbidden', { details: { reason: 'bad_signature' } })
    }
    const body = JSON.stringify({
      id: 'vendor-1',
      subject_id: TEST_HUMAN_ID,
      secret: 'vendor-secret',
    })
    const err = await handleVerificationWebhook(
      deps,
      fakeRequest({ method: 'POST', url: '/x', headers: { 'x-signature': 'nope' }, body }),
    ).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'forbidden' })
    expect(JSON.stringify(mapError(err).body)).not.toContain('vendor-secret')
    expect(db.recorded).toHaveLength(0)
    // The raw body reached the provider untouched for the signature check.
    expect(verification.webhooks[0]).toEqual({ rawBody: body, signature: 'nope' })
  })
})
