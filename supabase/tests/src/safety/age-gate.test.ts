/**
 * Age gating (spec §84 "Minor handling"; ARCHITECTURE §4 "Age gating"; migration 1020).
 *
 * Earth launches 18+, so the architecture is here while the product scope is not: `unknown` — what
 * every Human has today — claims exactly as it did before 1020, an `adult` claims, and a Human the
 * verification provider marked `minor` is refused with `age_not_allowed` while
 * `app_settings.minimum_age_policy` is `18_plus`. The bracket is a verification result: the service
 * is the only writer and every client role is denied, so nobody can claim their way past the gate
 * or mark anyone else a minor.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  count,
  createGuest,
  createHuman,
  createUnclaimed,
  isPermissionDenied,
  scalar,
  setSetting,
  type Human,
} from './fixtures'
import { createTestDb, type RoleSpec, type TestDb } from '../harness'

type Bracket = 'unknown' | 'adult' | 'minor'

let handleCounter = 0
function freshHandle(prefix: string): string {
  handleCounter += 1
  return `${prefix}${handleCounter}`.toLowerCase().slice(0, 24)
}

interface Claimant {
  userId: string
  as: RoleSpec
  humanId: string
  handle: string
}

/** claim_start → claim_set_identity → verification recorded as verified: one step short of claiming. */
async function claimReadyToComplete(db: TestDb, prefix: string): Promise<Claimant> {
  const user = await createUnclaimed(db)
  const handle = freshHandle(prefix)
  const started = await db.rpc<{ humanId: string }>(
    'claim_start',
    { intent: 'start_group', group_label: 'Crew' },
    user.as,
  )
  await db.rpc('claim_set_identity', { display_name: handle, handle }, user.as)
  await db.rpc('claim_verification_begin', { provider: 'mock' }, user.as)
  await db.rpc(
    'human_pass_record_result',
    {
      human_id: started.humanId,
      status: 'verified',
      risk_level: null,
      provider: 'mock',
      provider_reference: null,
      metadata: {},
      duplicate_of_human_id: null,
    },
    'service',
  )
  return { userId: user.userId, as: user.as, humanId: started.humanId, handle }
}

/** The verification provider integration: the service is the only writer of the column. */
async function markBracket(db: TestDb, humanId: string, bracket: Bracket): Promise<void> {
  await db.sql.query(
    'update public.humans set age_bracket = $2::public.age_bracket where id = $1',
    [humanId, bracket],
  )
}

async function bracketOf(db: TestDb, humanId: string): Promise<string | null> {
  return scalar<string | null>(db, 'age_bracket::text from public.humans where id = $1', [humanId])
}

async function statusOf(db: TestDb, humanId: string): Promise<string | null> {
  return scalar<string | null>(db, 'status::text from public.humans where id = $1', [humanId])
}

async function policyAllows(db: TestDb, humanId: string): Promise<boolean> {
  return scalar<boolean>(db, 'earth.age_policy_allows($1)', [humanId])
}

describe('age gating (spec §84)', () => {
  let db: TestDb
  let alice: Human

  beforeAll(async () => {
    db = await createTestDb()
    alice = await createHuman(db, { handle: 'agealice', displayName: 'Alice' })
  })

  afterAll(async () => {
    await db.drop()
  })

  beforeEach(async () => {
    await setSetting(db, 'minimum_age_policy', '18_plus')
  })

  it('ships the launch policy and gives every Human the `unknown` bracket', async () => {
    expect(await scalar<string>(db, "earth.setting('minimum_age_policy')")).toBe('18_plus')
    expect(await bracketOf(db, alice.humanId)).toBe('unknown')
    expect(await count(db, 'public.humans', "age_bracket <> 'unknown'")).toBe(0)
    expect(await policyAllows(db, alice.humanId)).toBe(true)
  })

  it('`unknown` claims exactly as it did before the gate existed', async () => {
    const claimant = await claimReadyToComplete(db, 'ageunknown')
    expect(await bracketOf(db, claimant.humanId)).toBe('unknown')
    const completed = await db.rpc<{ humanId: string; groupId: string | null }>(
      'claim_complete',
      {},
      claimant.as,
    )
    expect(completed.humanId).toBe(claimant.humanId)
    expect(completed.groupId).not.toBeNull()
    expect(await statusOf(db, claimant.humanId)).toBe('active')
    // Claiming never touches the bracket: only the verification provider writes it.
    expect(await bracketOf(db, claimant.humanId)).toBe('unknown')
  })

  it('an adult claims under the 18+ policy', async () => {
    const claimant = await claimReadyToComplete(db, 'ageadult')
    await markBracket(db, claimant.humanId, 'adult')
    expect(await policyAllows(db, claimant.humanId)).toBe(true)
    await db.rpc('claim_complete', {}, claimant.as)
    expect(await statusOf(db, claimant.humanId)).toBe('active')
  })

  it('a service-marked minor is refused with age_not_allowed and stays pending', async () => {
    const claimant = await claimReadyToComplete(db, 'ageminor')
    await markBracket(db, claimant.humanId, 'minor')
    expect(await policyAllows(db, claimant.humanId)).toBe(false)

    await db.expectError(db.rpc('claim_complete', {}, claimant.as), 'age_not_allowed')

    expect(await statusOf(db, claimant.humanId)).toBe('pending')
    expect(
      await scalar<string | null>(db, 'claimed_at::text from public.humans where id = $1', [
        claimant.humanId,
      ]),
    ).toBeNull()
    // The refusal is complete: no group, no conversation, no human_context row was created.
    expect(await count(db, 'public.group_members', 'human_id = $1', [claimant.humanId])).toBe(0)
    expect(await count(db, 'public.human_context', 'human_id = $1', [claimant.humanId])).toBe(0)
    // And it is stable: retrying does not eventually let them through.
    await db.expectError(db.rpc('claim_complete', {}, claimant.as), 'age_not_allowed')
    expect(await statusOf(db, claimant.humanId)).toBe('pending')
  })

  it('the gate is a policy, not a rule: `all_ages` admits the same minor', async () => {
    const claimant = await claimReadyToComplete(db, 'agepolicy')
    await markBracket(db, claimant.humanId, 'minor')
    await db.expectError(db.rpc('claim_complete', {}, claimant.as), 'age_not_allowed')

    await setSetting(db, 'minimum_age_policy', 'all_ages')
    expect(await policyAllows(db, claimant.humanId)).toBe(true)
    await db.rpc('claim_complete', {}, claimant.as)
    expect(await statusOf(db, claimant.humanId)).toBe('active')
  })

  it('fails closed: an unrecognised or missing policy value refuses a minor', async () => {
    const claimant = await claimReadyToComplete(db, 'agefailclosed')
    await markBracket(db, claimant.humanId, 'minor')

    for (const value of ['', '  ', 'eighteen_plus', 'ALL_AGES']) {
      await setSetting(db, 'minimum_age_policy', value)
      expect(await policyAllows(db, claimant.humanId), value).toBe(false)
      await db.expectError(db.rpc('claim_complete', {}, claimant.as), 'age_not_allowed')
    }

    await db.sql.query("delete from public.app_settings where key = 'minimum_age_policy'")
    expect(await policyAllows(db, claimant.humanId)).toBe(false)
    await db.expectError(db.rpc('claim_complete', {}, claimant.as), 'age_not_allowed')
    expect(await statusOf(db, claimant.humanId)).toBe('pending')

    await setSetting(db, 'minimum_age_policy', '18_plus')
  })

  it('no client role can write age_bracket — not on their own row, not on anyone else’s', async () => {
    const claimant = await claimReadyToComplete(db, 'agewriter')
    await markBracket(db, claimant.humanId, 'minor')
    const guest = await createGuest(db)
    const callers: RoleSpec[] = [claimant.as, alice.as, guest.as, 'visitor']

    for (const as of callers) {
      for (const target of [claimant.humanId, alice.humanId]) {
        let failure: unknown
        try {
          await db.asRole(as, (client) =>
            client.query(
              "update public.humans set age_bracket = 'adult'::public.age_bracket where id = $1",
              [target],
            ),
          )
        } catch (error) {
          failure = error
        }
        expect(
          isPermissionDenied(failure),
          `expected permission denied for ${JSON.stringify(as)}, got ${String(failure)}`,
        ).toBe(true)
      }
    }

    expect(await bracketOf(db, claimant.humanId)).toBe('minor')
    expect(await bracketOf(db, alice.humanId)).toBe('unknown')
    await db.expectError(db.rpc('claim_complete', {}, claimant.as), 'age_not_allowed')

    // No RPC hands the column to a client either: no write privilege exists on public.humans.
    const writable = await scalar<string[]>(
      db,
      `coalesce(array_agg(distinct grantee::text || ' ' || privilege_type::text order by grantee::text || ' ' || privilege_type::text), '{}'::text[])
         from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'humans'
          and grantee in ('anon', 'authenticated')
          and privilege_type <> 'SELECT'`,
    )
    expect(writable).toEqual([])
  })

  it('no client can even ask the gate about someone (spec §78: verification is private)', async () => {
    const claimant = await claimReadyToComplete(db, 'ageprobe')
    await markBracket(db, claimant.humanId, 'minor')
    const guest = await createGuest(db)

    for (const as of [claimant.as, alice.as, guest.as, 'visitor'] as RoleSpec[]) {
      let failure: unknown
      try {
        await db.asRole(as, (client) =>
          client.query('select earth.age_policy_allows($1)', [claimant.humanId]),
        )
      } catch (error) {
        failure = error
      }
      expect(
        isPermissionDenied(failure),
        `expected permission denied for ${JSON.stringify(as)}, got ${String(failure)}`,
      ).toBe(true)
    }
    // The service still reads it, and so does claim_complete.
    expect(await policyAllows(db, claimant.humanId)).toBe(false)
  })
})
