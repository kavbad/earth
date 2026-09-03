/**
 * Human verification routes end to end (ARCHITECTURE §6; spec §15, §48, §77, §78, §111; DB_API §1):
 * `POST /api/claim/verification/start` with the mock provider records the result through the
 * service RPC `human_pass_record_result`; `GET /api/claim/verification/:sessionId` answers only
 * the status and the §111 failure kind; `claim_complete` then activates a verified Human, refuses a
 * duplicate (`identity_reviews` row, `duplicate_human`) and waits on an inconclusive result.
 */
import {
  ClaimCompleteDtoSchema,
  ClaimStateDtoSchema,
  VerificationSessionDtoSchema,
  type HumanId,
} from '@earth/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MOCK_SESSION_TTL_MS } from '../../../../packages/auth/src/verification/index'
import { VerificationResultDtoSchema } from '../../../../packages/server/src/index'
import { count, createHuman, createUnclaimed, scalar, type Human } from '../admission/fixtures'
import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  createEarthServer,
  createServerTestDeps,
  errorCodeOf,
  fakeRequest,
  type EarthServer,
  type ServerTestDeps,
} from './server-deps'

interface Claimant {
  as: RoleSpec
  humanId: string
  bearer: string
}

describe('claim verification routes (server tier ↔ claim RPCs)', () => {
  let db: TestDb
  let ctx: ServerTestDeps
  let server: EarthServer
  let existing: Human

  async function claimant(name: string, handle: string): Promise<Claimant> {
    const user = await createUnclaimed(db)
    await db.rpc('claim_start', { intent: 'start_group', group_label: 'Weekend Crew' }, user.as)
    const state = ClaimStateDtoSchema.parse(
      await db.rpc('claim_set_identity', { display_name: name, handle }, user.as),
    )
    return { as: user.as, humanId: state.humanId, bearer: ctx.tokens.for(user.as) }
  }

  async function start(bearer: string | undefined, hint: string) {
    return server.handle(
      fakeRequest({
        method: 'POST',
        url: '/api/claim/verification/start',
        ...(bearer === undefined ? {} : { bearer }),
        body: { locale: 'en-US', platform: 'ios', hint },
      }),
    )
  }

  async function result(bearer: string | undefined, sessionId: string) {
    return server.handle(
      fakeRequest({
        url: `/api/claim/verification/${encodeURIComponent(sessionId)}`,
        ...(bearer === undefined ? {} : { bearer }),
      }),
    )
  }

  beforeAll(async () => {
    db = await createTestDb()
    existing = await createHuman(db, { handle: 'existing', displayName: 'Existing' })
    // The mock's duplicate outcome must name a real Human: the RPC checks the reference.
    ctx = createServerTestDeps(db, { mock: { duplicateOfHumanId: existing.humanId as HumanId } })
    server = createEarthServer(ctx.deps)
  })

  afterAll(async () => {
    await db.drop()
  })

  it('verified: start records the mock result and claim_complete activates the Human', async () => {
    const alex = await claimant('Alex', 'alexclaim')
    const res = await start(alex.bearer, 'verified')
    expect(res.status).toBe(200)
    const session = VerificationSessionDtoSchema.parse(res.body)
    expect(session).toEqual({
      sessionId: expect.stringMatching(/^mock-session-\d+$/) as string,
      status: 'verified',
      providerUrl: null,
      expiresAt: new Date(ctx.clock.now.getTime() + MOCK_SESSION_TTL_MS).toISOString(),
    })
    // Nothing private leaves the server (spec §19, §78).
    expect(Object.keys(res.body as object).sort()).toEqual([
      'expiresAt',
      'providerUrl',
      'sessionId',
      'status',
    ])

    // The pass and its private metadata were recorded through the service RPC.
    expect(ctx.callsTo('claim_verification_begin').at(-1)).toMatchObject({
      client: `user:${alex.bearer}`,
      args: { provider: 'mock' },
    })
    expect(ctx.callsTo('human_pass_record_result')).toHaveLength(2)
    expect(ctx.callsTo('human_pass_record_result').every((call) => call.client === 'admin')).toBe(
      true,
    )
    expect(
      await scalar(db, 'status::text from public.human_passes where human_id = $1', [alex.humanId]),
    ).toBe('verified')
    expect(
      await scalar(db, 'provider from public.human_passes where human_id = $1', [alex.humanId]),
    ).toBe('mock')
    expect(
      await scalar(db, 'provider_reference from public.human_passes where human_id = $1', [
        alex.humanId,
      ]),
    ).toBe(session.sessionId)
    expect(
      await count(
        db,
        'private.human_pass_metadata',
        "metadata ->> 'provider' = 'mock' and metadata ->> 'sessionId' = $1",
        [session.sessionId],
      ),
    ).toBe(1)
    expect(ClaimStateDtoSchema.parse(await db.rpc('claim_get', {}, alex.as))).toMatchObject({
      status: 'verified',
      verification: { status: 'verified', sessionId: session.sessionId },
    })

    const polled = await result(alex.bearer, session.sessionId)
    expect(polled.status).toBe(200)
    expect(VerificationResultDtoSchema.parse(polled.body)).toEqual({
      sessionId: session.sessionId,
      status: 'verified',
      failureKind: null,
    })

    const done = ClaimCompleteDtoSchema.parse(await db.rpc('claim_complete', {}, alex.as))
    expect(done.humanId).toBe(alex.humanId)
    expect(await scalar(db, 'status::text from public.humans where id = $1', [alex.humanId])).toBe(
      'active',
    )
    expect(await scalar(db, 'name from public.groups where id = $1', [done.groupId])).toBe(
      'Weekend Crew',
    )
  })

  it('duplicate: a duplicate review opens and claim_complete raises duplicate_human', async () => {
    const bea = await claimant('Bea', 'beaclaim')
    const res = await start(bea.bearer, 'duplicate')
    expect(res.status).toBe(200)
    const session = VerificationSessionDtoSchema.parse(res.body)
    expect(session.status).toBe('review_required')
    expect(
      await count(
        db,
        'public.identity_reviews',
        "human_id = $1 and kind = 'duplicate' and status = 'open' and duplicate_of_human_id = $2",
        [bea.humanId, existing.humanId],
      ),
    ).toBe(1)
    expect(
      await scalar(db, 'human_pass_status::text from public.humans where id = $1', [bea.humanId]),
    ).toBe('review_required')

    const polled = await result(bea.bearer, session.sessionId)
    expect(polled.status).toBe(200)
    expect(VerificationResultDtoSchema.parse(polled.body)).toEqual({
      sessionId: session.sessionId,
      status: 'review_required',
      failureKind: 'duplicate',
    })
    // Polling again never opens a second review.
    expect(
      await count(db, 'public.identity_reviews', "human_id = $1 and kind = 'duplicate'", [
        bea.humanId,
      ]),
    ).toBe(1)

    await db.expectError(db.rpc('claim_complete', {}, bea.as), 'duplicate_human')
    expect(await scalar(db, 'status::text from public.humans where id = $1', [bea.humanId])).toBe(
      'pending',
    )
  })

  it('inconclusive: failureKind inconclusive, no review row, completion waits for a person', async () => {
    const cal = await claimant('Cal', 'calclaim')
    const session = VerificationSessionDtoSchema.parse(
      (await start(cal.bearer, 'inconclusive')).body,
    )
    expect(session.status).toBe('review_required')
    const polled = await result(cal.bearer, session.sessionId)
    expect(VerificationResultDtoSchema.parse(polled.body)).toEqual({
      sessionId: session.sessionId,
      status: 'review_required',
      failureKind: 'inconclusive',
    })
    expect(await count(db, 'public.identity_reviews', 'human_id = $1', [cal.humanId])).toBe(0)
    await db.expectError(db.rpc('claim_complete', {}, cal.as), 'verification_pending')
  })

  it('technical: failureKind technical resets the pass so the person can try again', async () => {
    const dan = await claimant('Dan', 'danclaim')
    const session = VerificationSessionDtoSchema.parse((await start(dan.bearer, 'technical')).body)
    expect(session.status).toBe('unverified')
    const polled = await result(dan.bearer, session.sessionId)
    expect(VerificationResultDtoSchema.parse(polled.body)).toEqual({
      sessionId: session.sessionId,
      status: 'unverified',
      failureKind: 'technical',
    })
    await db.expectError(db.rpc('claim_complete', {}, dan.as), 'verification_required')
  })

  it('a session belongs to its claimant; the routes need a bearer', async () => {
    const eli = await claimant('Eli', 'eliclaim')
    const fay = await claimant('Fay', 'fayclaim')
    const session = VerificationSessionDtoSchema.parse((await start(eli.bearer, 'verified')).body)
    const foreign = await result(fay.bearer, session.sessionId)
    expect(foreign.status).toBe(404)
    expect(errorCodeOf(foreign)).toBe('not_visible')
    expect((await start(undefined, 'verified')).status).toBe(401)
    expect((await result(undefined, session.sessionId)).status).toBe(401)
    // The RPCs answer a Human that is not claiming with the database code, not a 500.
    const unknown = await start('not-a-session', 'verified')
    expect(unknown.status).toBe(401)
    expect(errorCodeOf(unknown)).toBe('not_authenticated')
  })
})
