/**
 * Adversarial verification of the "identity" invariant cluster (ARCHITECTURE §4, spec §42–49,
 * §77–80, DB_API §1):
 *
 *   - Guest is not Human.
 *   - Public identity is not Human identity (a credential is never a Human either).
 *   - A Human cannot silently create a second Human.
 *   - Pending Humans are invisible everywhere.
 *   - Human Pass metadata is service-only.
 *   - Claim is group-anchored while GROUP_ANCHORED_CLAIM_REQUIRED is on.
 *   - Recovery and duplicate paths never activate a second Human.
 *
 * Every test is a concrete sequence of RPC calls as specific callers that tries to break the
 * invariant; fixtures use direct SQL only to set up state (or to play the admin, who has no RPC).
 */
import {
  ClaimCompleteDtoSchema,
  ClaimStateDtoSchema,
  MeDtoSchema,
  ProfileDtoSchema,
} from '@earth/domain'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  befriend,
  count,
  createGroup,
  createGuest,
  createHuman,
  createInvite,
  createUnclaimed,
  scalar,
  setFlag,
  uniqueEmail,
  type Human,
} from '../admission/fixtures'
import { createTestDb, type RoleSpec, type TestDb } from '../harness'

const PERMISSION_DENIED = '42501'
const UNIQUE_VIOLATION = '23505'
const RAISE_EXCEPTION = 'P0001'
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

interface ClaimState {
  status: string
  intent: string | null
  groupLabel: string | null
  identity: { displayName: string; handle: string; avatarUrl: string | null } | null
  verification: { status: string; sessionId?: string }
  humanId: string
}

interface Review {
  id: string
  humanId: string
  kind: string
  status: string
}

let handleCounter = 0
/** A fresh valid handle (lowercase, 3–24 chars). */
function freshHandle(prefix: string): string {
  handleCounter += 1
  return `${prefix}${handleCounter}`.toLowerCase().slice(0, 24)
}

async function expectDenied(promise: Promise<unknown>): Promise<void> {
  let failure: unknown
  try {
    await promise
  } catch (error) {
    failure = error
  }
  const denied = failure instanceof pg.DatabaseError && failure.code === PERMISSION_DENIED
  expect(denied, `expected permission denied (42501), got ${String(failure)}`).toBe(true)
}

async function statusOf(db: TestDb, humanId: string): Promise<string | null> {
  return scalar<string | null>(db, 'status::text from public.humans where id = $1', [humanId])
}

async function passStatusOf(db: TestDb, humanId: string): Promise<string | null> {
  return scalar<string | null>(db, 'human_pass_status::text from public.humans where id = $1', [
    humanId,
  ])
}

async function recordResult(
  db: TestDb,
  humanId: string,
  status: string,
  extra: Record<string, unknown> = {},
): Promise<ClaimState> {
  return db.rpc<ClaimState>(
    'human_pass_record_result',
    {
      human_id: humanId,
      status,
      risk_level: null,
      provider: 'mock',
      provider_reference: null,
      metadata: {},
      duplicate_of_human_id: null,
      ...extra,
    },
    'service',
  )
}

/** The admin resolving a review (no RPC exists for it; spec §48/§79 reviews are resolved by people). */
async function resolveReview(
  db: TestDb,
  reviewId: string,
  status: 'approved' | 'rejected',
): Promise<void> {
  await db.sql.query(
    'update public.identity_reviews set status = $2, resolved_at = now() where id = $1',
    [reviewId, status],
  )
}

async function openDuplicateReviews(db: TestDb, humanId: string): Promise<number> {
  return count(
    db,
    'public.identity_reviews',
    "human_id = $1 and kind = 'duplicate' and status = 'open'",
    [humanId],
  )
}

/** claim_start + claim_set_identity + claim_verification_begin as `as`; returns the pending state. */
async function claimToVerifying(
  db: TestDb,
  as: RoleSpec,
  handle: string,
  start: Record<string, unknown> = { intent: 'start_group' },
): Promise<ClaimState> {
  const started = await db.rpc<ClaimState>('claim_start', start, as)
  await db.rpc('claim_set_identity', { display_name: handle, handle }, as)
  await db.rpc('claim_verification_begin', { provider: 'mock' }, as)
  return started
}

describe('identity invariants — adversarial verification', () => {
  let db: TestDb
  let alice: Human
  let bob: Human

  beforeAll(async () => {
    db = await createTestDb()
    alice = await createHuman(db, { handle: 'alice', displayName: 'Alice' })
    bob = await createHuman(db, { handle: 'bob', displayName: 'Bob' })
    await befriend(db, alice, bob)
  })

  afterAll(async () => {
    await db.drop()
  })

  // -------------------------------------------------------------------------------------------------
  describe('Guest is not Human', () => {
    it('every claim-flow RPC refuses a Guest with guest_not_allowed and creates no Human state', async () => {
      const guest = await createGuest(db)
      await db.expectError(
        db.rpc('claim_start', { intent: 'start_group', group_label: 'G' }, guest.as),
        'guest_not_allowed',
      )
      await db.expectError(db.rpc('claim_get', {}, guest.as), 'guest_not_allowed')
      await db.expectError(
        db.rpc('claim_set_identity', { display_name: 'G', handle: 'ghost' }, guest.as),
        'guest_not_allowed',
      )
      await db.expectError(
        db.rpc('claim_verification_begin', { provider: 'mock' }, guest.as),
        'guest_not_allowed',
      )
      await db.expectError(db.rpc('claim_complete', {}, guest.as), 'guest_not_allowed')
      await db.expectError(
        db.rpc('identity_review_create', { kind: 'help' }, guest.as),
        'guest_not_allowed',
      )
      expect(await count(db, 'public.humans', 'auth_user_id = $1', [guest.userId])).toBe(0)
      expect(await count(db, 'public.public_identities', "handle = 'ghost'")).toBe(0)
      expect(await count(db, 'public.identity_reviews', 'true')).toBe(0)
      expect(MeDtoSchema.parse(await db.rpc('me_get', {}, guest.as))).toMatchObject({
        roleKind: 'guest',
        humanId: null,
        identity: null,
        humanStatus: null,
      })
    })

    it('every Human-only RPC refuses a Guest with not_a_human', async () => {
      const guest = await createGuest(db)
      const calls: Array<[string, Record<string, unknown>]> = [
        ['identity_update', { display_name: 'G' }],
        ['friend_request_send', { target_human_id: alice.humanId }],
        ['friend_request_accept', { source_human_id: alice.humanId }],
        ['follow_set', { target_human_id: alice.humanId, following: true }],
        ['block_set', { target_human_id: alice.humanId, blocked: true }],
        ['presence_ping', { platform: 'web' }],
        ['context_set', {}],
        ['scope_set', { surface: 'home', scope: 'friends' }],
        ['push_token_register', { token: 'tok', platform: 'web' }],
        ['group_create', { name: 'Guests' }],
        ['conversation_direct_get_or_create', { other_human_id: alice.humanId }],
        ['conversations_list', {}],
      ]
      for (const [name, args] of calls) {
        await db.expectError(db.rpc(name, args, guest.as), 'not_a_human')
      }
      expect(await count(db, 'public.relationships', 'target_human_id = $1', [alice.humanId])).toBe(
        1,
      )
      expect(await count(db, 'public.groups', "name = 'Guests'")).toBe(0)
    })

    it('a Human, a claiming Human, an unclaimed credential and the service can never open a Guest session', async () => {
      const claiming = await createHuman(db, { handle: freshHandle('cl'), status: 'pending' })
      const unclaimed = await createUnclaimed(db)
      for (const as of [alice.as, claiming.as, unclaimed.as, 'service'] as RoleSpec[]) {
        await db.expectError(
          db.rpc('guest_session_create', { token: 'bogus', display_name: 'Sam' }, as),
          'forbidden',
        )
      }
      await db.expectError(
        db.rpc('guest_session_create', { token: 'bogus', display_name: 'Sam' }, 'visitor'),
        'not_authenticated',
      )
      expect(await count(db, 'public.guest_sessions', 'true')).toBe(0)
    })

    it('a Human row linked to an anonymous credential still gives a Guest JWT no Human powers', async () => {
      // Defense in depth: even if the service (or a bug) linked a Human to an anonymous auth user,
      // the anonymous JWT must keep reading as a Guest (ARCHITECTURE §4: current_human_id() is null).
      const guest = await createGuest(db)
      const { rows } = await db.sql.query<{ id: string }>(
        `insert into public.humans (status, human_pass_status, auth_user_id, claimed_at)
         values ('active', 'verified', $1, now()) returning id`,
        [guest.userId],
      )
      const humanId = rows[0]?.id
      if (humanId === undefined) throw new Error('humans insert returned no id')
      await db.sql.query(
        `insert into public.public_identities (human_id, display_name, handle, profile_visibility)
         values ($1, 'Linked', 'linkedguest', 'hidden')`,
        [humanId],
      )
      try {
        expect(MeDtoSchema.parse(await db.rpc('me_get', {}, guest.as))).toMatchObject({
          roleKind: 'guest',
          humanId: null,
        })
        await db.expectError(db.rpc('identity_update', { bio: 'x' }, guest.as), 'not_a_human')
        await db.expectError(db.rpc('claim_get', {}, guest.as), 'guest_not_allowed')
        // RLS surfaces that key on earth.current_human_id() / earth.current_human() must not open up.
        const hiddenIdentity = await db.asRole(guest.as, (c) =>
          c.query('select human_id from public.public_identities where human_id = $1', [humanId]),
        )
        expect(hiddenIdentity.rowCount).toBe(0)
        const ownRow = await db.asRole(guest.as, (c) =>
          c.query('select id from public.humans where id = $1', [humanId]),
        )
        expect(ownRow.rowCount).toBe(0)
        const edited = await db.asRole(guest.as, (c) =>
          c.query("update public.public_identities set bio = 'guest' where human_id = $1", [
            humanId,
          ]),
        )
        expect(edited.rowCount).toBe(0)
        await expect(
          db.asRole(guest.as, (c) =>
            c.query('insert into public.human_context (human_id) values ($1)', [humanId]),
          ),
        ).rejects.toMatchObject({ code: PERMISSION_DENIED })
        await expect(
          db.asRole(guest.as, (c) =>
            c.query(
              `insert into public.media_objects (owner_human_id, bucket, storage_key, content_type)
               values ($1, 'avatars', 'g/a.jpg', 'image/jpeg')`,
              [humanId],
            ),
          ),
        ).rejects.toMatchObject({ code: PERMISSION_DENIED })
      } finally {
        await db.sql.query('delete from public.humans where id = $1', [humanId])
      }
    })
  })

  // -------------------------------------------------------------------------------------------------
  describe('Public identity is not Human identity', () => {
    it('changing the public identity never changes the Human or its relationships', async () => {
      const before = ProfileDtoSchema.parse(
        await db.rpc('profile_get', { handle: 'alice' }, bob.as),
      )
      expect(before.identity.humanId).toBe(alice.humanId)
      await db.rpc('identity_update', { display_name: 'Alicia', bio: 'moved' }, alice.as)
      const after = ProfileDtoSchema.parse(await db.rpc('profile_get', { handle: 'alice' }, bob.as))
      expect(after.identity).toMatchObject({
        humanId: alice.humanId,
        displayName: 'Alicia',
        handle: 'alice',
      })
      expect(after.relationship.isFriend).toBe(true)
      expect(
        await count(
          db,
          'public.relationships',
          "type = 'friend' and (source_human_id = $1 or target_human_id = $1)",
          [alice.humanId],
        ),
      ).toBe(2)
      // The handle is the one public attribute clients may not rewrite; the Human id is the key.
      await expectDenied(
        db.asRole(alice.as, (c) =>
          c.query("update public.public_identities set handle = 'alicia' where human_id = $1", [
            alice.humanId,
          ]),
        ),
      )
      await db.rpc('identity_update', { display_name: 'Alice', bio: '' }, alice.as)
    })

    it('losing the credential keeps the Human; a fresh credential with the same email is not that Human', async () => {
      const email = uniqueEmail()
      const carol = await createHuman(db, { handle: 'carol', displayName: 'Carol', email })
      await befriend(db, carol, bob)
      await db.sql.query('delete from auth.users where id = $1', [carol.userId])

      expect(await statusOf(db, carol.humanId)).toBe('active')
      expect(
        await scalar(db, 'auth_user_id from public.humans where id = $1', [carol.humanId]),
      ).toBeNull()
      const seenByBob = ProfileDtoSchema.parse(
        await db.rpc('profile_get', { handle: 'carol' }, bob.as),
      )
      expect(seenByBob.relationship.isFriend).toBe(true)

      const replacement = await db.createAuthUser({ email })
      const me = MeDtoSchema.parse(await db.rpc('me_get', {}, { userId: replacement }))
      expect(me).toMatchObject({ roleKind: 'claiming', humanId: null, identity: null })
      await db.expectError(db.rpc('claim_get', {}, { userId: replacement }), 'claim_not_pending')
      await db.expectError(
        db.rpc('identity_update', { display_name: 'Not Carol' }, { userId: replacement }),
        'not_a_human',
      )
      // Nothing about Carol changed hands.
      expect(await count(db, 'public.humans', 'auth_user_id = $1', [replacement])).toBe(0)
      expect(
        await scalar(db, 'display_name from public.public_identities where human_id = $1', [
          carol.humanId,
        ]),
      ).toBe('Carol')
    })

    it('a credential re-claiming after its Human was deleted links the new pending Human, never the deleted one', async () => {
      const dan = await createHuman(db, { handle: 'dan', displayName: 'Dan' })
      // The deletion flow (service): status deleted, credential unlinked, identity kept for tombstones.
      await db.sql.query(
        `update public.humans set status = 'deleted', deleted_at = now(), auth_user_id = null where id = $1`,
        [dan.humanId],
      )
      const started = ClaimStateDtoSchema.parse(
        await db.rpc('claim_start', { intent: 'start_group', group_label: 'Again' }, dan.as),
      )
      expect(started.humanId).not.toBe(dan.humanId)
      expect(started.status).toBe('started')
      expect(await statusOf(db, dan.humanId)).toBe('deleted')
      expect(await statusOf(db, started.humanId)).toBe('pending')
      expect(MeDtoSchema.parse(await db.rpc('me_get', {}, dan.as))).toMatchObject({
        roleKind: 'claiming',
        humanId: started.humanId,
        humanStatus: 'pending',
      })
      // The credential → Human link table follows the credential (DB_API §1: one `supabase` row per
      // Human whose subject is its auth user), so nothing keeps pointing at the deleted Human.
      expect(
        await scalar(
          db,
          `human_id from public.auth_identities where provider = 'supabase' and provider_subject = $1`,
          [dan.userId],
        ),
      ).toBe(started.humanId)
      expect(
        await count(db, 'public.auth_identities', "human_id = $1 and provider = 'supabase'", [
          started.humanId,
        ]),
      ).toBe(1)
      // No duplicate review: the previous Human of this credential is deleted, not a second person.
      expect(await openDuplicateReviews(db, started.humanId)).toBe(0)
    })
  })

  // -------------------------------------------------------------------------------------------------
  describe('A Human cannot silently create a second Human', () => {
    it('an active, restricted or suspended Human cannot start another claim', async () => {
      const restricted = await createHuman(db, { handle: freshHandle('res'), status: 'restricted' })
      const suspended = await createHuman(db, { handle: freshHandle('sus'), status: 'suspended' })
      for (const human of [alice, restricted, suspended]) {
        await db.expectError(
          db.rpc('claim_start', { intent: 'start_group' }, human.as),
          'duplicate_human',
        )
        await db.expectError(db.rpc('claim_complete', {}, human.as), 'claim_not_pending')
        expect(await count(db, 'public.humans', 'auth_user_id = $1', [human.userId])).toBe(1)
      }
      // Not even by hand.
      await expect(
        db.sql.query(
          `insert into public.humans (status, auth_user_id, claimed_at) values ('pending', $1, null)`,
          [alice.userId],
        ),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION })
    })

    it('concurrent claim_start calls for one credential create exactly one Human and answer with a machine code', async () => {
      const user = await createUnclaimed(db)
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const first = db.asRole(user.as, async (client) => {
        const result = await client.query(`select public.claim_start('start_group', 'Race')`)
        await gate
        return result.rows.length
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      const second = db
        .rpc<ClaimState>('claim_start', { intent: 'start_group', group_label: 'Race' }, user.as)
        .then(
          (state) => ({ ok: true as const, state }),
          (error: unknown) => ({ ok: false as const, error }),
        )
      await new Promise((resolve) => setTimeout(resolve, 300))
      release()
      expect(await first).toBe(1)
      const outcome = await second
      if (!outcome.ok) {
        const error = outcome.error
        expect(error).toBeInstanceOf(pg.DatabaseError)
        expect((error as pg.DatabaseError).code).toBe(RAISE_EXCEPTION)
      }
      expect(await count(db, 'public.humans', 'auth_user_id = $1', [user.userId])).toBe(1)
      expect(
        await count(
          db,
          'public.auth_identities',
          "provider = 'supabase' and provider_subject = $1",
          [user.userId],
        ),
      ).toBe(1)
    })

    it('a second credential carrying a verified email of an existing Human is flagged as a likely duplicate, never activated silently', async () => {
      const email = uniqueEmail()
      const erin = await createHuman(db, { handle: 'erin', displayName: 'Erin', email })
      await db.sql.query(
        `insert into public.auth_identities (human_id, provider, provider_subject, verified_at)
         values ($1, 'email', $2, now())`,
        [erin.humanId, email],
      )
      // Erin loses her phone and signs up again with the same email on a new credential.
      const second = await db.createAuthUser({ email: uniqueEmail() })
      const as: RoleSpec = { userId: second, claims: { email } }
      const started = ClaimStateDtoSchema.parse(
        await db.rpc('claim_start', { intent: 'start_group', group_label: 'Erin 2' }, as),
      )
      expect(started.humanId).not.toBe(erin.humanId)
      // The system determined a likely existing Human (spec §48): a duplicate review is open.
      expect(await openDuplicateReviews(db, started.humanId)).toBe(1)
      expect(
        await scalar(
          db,
          `duplicate_of_human_id from public.identity_reviews where human_id = $1 and kind = 'duplicate'`,
          [started.humanId],
        ),
      ).toBe(erin.humanId)
      // The existing Human keeps her email row; the newcomer does not take it over.
      expect(
        await scalar(
          db,
          `human_id from public.auth_identities where provider = 'email' and provider_subject = $1`,
          [email],
        ),
      ).toBe(erin.humanId)

      // Even a fully verified pass cannot complete while the conflict is unresolved.
      await db.rpc('claim_set_identity', { display_name: 'Erin', handle: 'erin2' }, as)
      await db.rpc('claim_verification_begin', { provider: 'mock' }, as)
      await recordResult(db, started.humanId, 'verified')
      await db.expectError(db.rpc('claim_complete', {}, as), 'duplicate_human')
      expect(await statusOf(db, started.humanId)).toBe('pending')
      expect(await count(db, 'public.groups', "name = 'Erin 2'")).toBe(0)
      // Restarting the claim does not open a second review or clear the first.
      await db.rpc('claim_start', { intent: 'start_group', group_label: 'Erin 3' }, as)
      expect(await openDuplicateReviews(db, started.humanId)).toBe(1)

      // "This isn't me" accepted by a person: the conflict is resolved and the claim may complete.
      const reviewId = await scalar<string>(
        db,
        `id from public.identity_reviews where human_id = $1 and kind = 'duplicate'`,
        [started.humanId],
      )
      await resolveReview(db, reviewId, 'approved')
      const done = ClaimCompleteDtoSchema.parse(await db.rpc('claim_complete', {}, as))
      expect(done.humanId).toBe(started.humanId)
      expect(await statusOf(db, erin.humanId)).toBe('active')
    })

    it('a second credential carrying a verified phone of an existing Human is flagged too', async () => {
      const phone = `+1555${String(Date.now()).slice(-7)}`
      const fay = await createHuman(db, { handle: 'fay', displayName: 'Fay' })
      await db.sql.query(
        `insert into public.auth_identities (human_id, provider, provider_subject, verified_at)
         values ($1, 'phone', $2, now())`,
        [fay.humanId, phone],
      )
      const second = await db.createAuthUser({ email: uniqueEmail() })
      const as: RoleSpec = { userId: second, claims: { phone } }
      const started = ClaimStateDtoSchema.parse(
        await db.rpc('claim_start', { intent: 'start_group' }, as),
      )
      expect(await openDuplicateReviews(db, started.humanId)).toBe(1)
      await db.rpc('claim_set_identity', { display_name: 'Fay', handle: 'fay2' }, as)
      await recordResult(db, started.humanId, 'verified')
      await db.expectError(db.rpc('claim_complete', {}, as), 'duplicate_human')
      expect(await statusOf(db, started.humanId)).toBe('pending')
    })

    it('a matching email of a deleted Human is not a duplicate', async () => {
      const email = uniqueEmail()
      const gone = await createHuman(db, { handle: 'gone', displayName: 'Gone', email })
      await db.sql.query(
        `insert into public.auth_identities (human_id, provider, provider_subject, verified_at)
         values ($1, 'email', $2, now())`,
        [gone.humanId, email],
      )
      await db.sql.query(
        `update public.humans set status = 'deleted', deleted_at = now(), auth_user_id = null where id = $1`,
        [gone.humanId],
      )
      const second = await db.createAuthUser({ email: uniqueEmail() })
      const as: RoleSpec = { userId: second, claims: { email } }
      const started = ClaimStateDtoSchema.parse(
        await db.rpc('claim_start', { intent: 'start_group' }, as),
      )
      expect(await openDuplicateReviews(db, started.humanId)).toBe(0)
      expect(
        await scalar(
          db,
          `human_id from public.auth_identities where provider = 'email' and provider_subject = $1`,
          [email],
        ),
      ).toBe(started.humanId)
    })

    it('a provider result carrying a duplicate hint never yields a verified pass', async () => {
      const user = await createUnclaimed(db)
      const started = await claimToVerifying(db, user.as, freshHandle('dup'))
      // The vendor says "verified" but also names an existing Human: that is a duplicate finding.
      const state = ClaimStateDtoSchema.parse(
        await recordResult(db, started.humanId, 'verified', { duplicate_of_human_id: bob.humanId }),
      )
      expect(state.status).not.toBe('verified')
      expect(await openDuplicateReviews(db, started.humanId)).toBe(1)
      expect(await passStatusOf(db, started.humanId)).toBe('review_required')
      expect(
        await scalar(db, 'status::text from public.human_passes where human_id = $1', [
          started.humanId,
        ]),
      ).toBe('review_required')
      expect(
        await count(db, 'public.human_passes', 'human_id = $1 and verified_at is not null', [
          started.humanId,
        ]),
      ).toBe(0)
      await db.expectError(db.rpc('claim_complete', {}, user.as), 'duplicate_human')
      expect(await statusOf(db, started.humanId)).toBe('pending')
      // The Human named as the duplicate is untouched.
      expect(await statusOf(db, bob.humanId)).toBe('active')
      expect(await count(db, 'public.identity_reviews', 'human_id = $1', [bob.humanId])).toBe(0)
    })

    it('a confirmed duplicate cannot be activated by re-running verification', async () => {
      const user = await createUnclaimed(db)
      const started = await claimToVerifying(db, user.as, freshHandle('rerun'))
      await recordResult(db, started.humanId, 'review_required', {
        duplicate_of_human_id: alice.humanId,
      })
      const reviewId = await scalar<string>(
        db,
        `id from public.identity_reviews where human_id = $1 and kind = 'duplicate'`,
        [started.humanId],
      )
      // A person confirms it: this really is Alice trying again.
      await resolveReview(db, reviewId, 'rejected')
      await db.expectError(db.rpc('claim_complete', {}, user.as), 'verification_pending')

      // The claimant simply retries verification; a mock/flaky provider passes without a hint.
      const begun = await db.rpc<{ status: string }>(
        'claim_verification_begin',
        { provider: 'mock' },
        user.as,
      )
      expect(begun.status).toBe('verifying')
      ClaimStateDtoSchema.parse(await recordResult(db, started.humanId, 'verified'))
      expect(await passStatusOf(db, started.humanId)).toBe('verified')
      await db.expectError(db.rpc('claim_complete', {}, user.as), 'duplicate_human')
      expect(await statusOf(db, started.humanId)).toBe('pending')
      expect(await count(db, 'public.group_members', 'human_id = $1', [started.humanId])).toBe(0)

      // Only an explicit approval by a person (spec §79 "Get help verifying") can override it.
      const help = await db.rpc<Review>('identity_review_create', { kind: 'help' }, user.as)
      await db.expectError(db.rpc('claim_complete', {}, user.as), 'duplicate_human')
      await resolveReview(db, help.id, 'approved')
      expect(ClaimStateDtoSchema.parse(await db.rpc('claim_get', {}, user.as)).status).toBe(
        'verified',
      )
      const done = ClaimCompleteDtoSchema.parse(await db.rpc('claim_complete', {}, user.as))
      expect(done.humanId).toBe(started.humanId)
    })

    it('an open duplicate review survives a new verification round and a clean verified result', async () => {
      const user = await createUnclaimed(db)
      const started = await claimToVerifying(db, user.as, freshHandle('round'))
      await recordResult(db, started.humanId, 'review_required', {
        duplicate_of_human_id: alice.humanId,
      })
      await db.rpc('claim_verification_begin', { provider: 'vendor' }, user.as)
      expect(await passStatusOf(db, started.humanId)).toBe('verifying')
      expect(await openDuplicateReviews(db, started.humanId)).toBe(1)
      await recordResult(db, started.humanId, 'verified')
      await db.expectError(db.rpc('claim_complete', {}, user.as), 'duplicate_human')
      expect(await statusOf(db, started.humanId)).toBe('pending')
    })
  })

  // -------------------------------------------------------------------------------------------------
  describe('Pending Humans are invisible', () => {
    let pending: Human
    let hiddenFriend: Human

    beforeAll(async () => {
      pending = await createHuman(db, { handle: 'pend', displayName: 'Pend', status: 'pending' })
      hiddenFriend = await createHuman(db, { handle: 'hidfriend', visibility: 'hidden' })
      // Even a friendship edge written by hand does not make a pending Human visible.
      await befriend(db, pending, hiddenFriend)
    })

    it('nobody but the pending Human sees their identity or row', async () => {
      const guest = await createGuest(db)
      const unclaimed = await createUnclaimed(db)
      for (const as of [
        'visitor',
        guest.as,
        unclaimed.as,
        alice.as,
        hiddenFriend.as,
      ] as RoleSpec[]) {
        await db.expectError(db.rpc('profile_get', { handle: 'pend' }, as), 'not_visible')
        const identity = await db.asRole(as, (c) =>
          c.query('select human_id from public.public_identities where human_id = $1', [
            pending.humanId,
          ]),
        )
        expect(identity.rowCount).toBe(0)
        const people = await db.rpc<{ people: Array<{ handle: string }> }>(
          'search',
          { q: 'pend', limit: 10 },
          as,
        )
        expect(people.people.map((p) => p.handle)).not.toContain('pend')
      }
      for (const as of [alice.as, hiddenFriend.as]) {
        const row = await db.asRole(as, (c) =>
          c.query('select id from public.humans where id = $1', [pending.humanId]),
        )
        expect(row.rowCount).toBe(0)
      }
      // Self still works (claim step).
      const own = ProfileDtoSchema.parse(
        await db.rpc('profile_get', { handle: 'pend' }, pending.as),
      )
      expect(own.relationship.isSelf).toBe(true)
      expect(MeDtoSchema.parse(await db.rpc('me_get', {}, pending.as))).toMatchObject({
        roleKind: 'claiming',
        humanId: pending.humanId,
        identity: { handle: 'pend' },
      })
    })

    it('no Human can target a pending Human through any social, messaging or safety RPC', async () => {
      const target = { target_human_id: pending.humanId }
      await db.expectError(db.rpc('friend_request_send', target, alice.as), 'not_visible')
      await db.expectError(
        db.rpc('follow_set', { ...target, following: true }, alice.as),
        'not_visible',
      )
      await db.expectError(
        db.rpc('block_set', { ...target, blocked: true }, alice.as),
        'not_visible',
      )
      await db.expectError(
        db.rpc('conversation_direct_get_or_create', { other_human_id: pending.humanId }, alice.as),
        'not_visible',
      )
      await db.expectError(
        db.rpc(
          'conversation_group_create',
          { human_ids: [pending.humanId, bob.humanId] },
          alice.as,
        ),
        'not_visible',
      )
      await db.expectError(
        db.rpc(
          'report_create',
          { target_type: 'human', target_id: pending.humanId, reason: 'spam_scam' },
          alice.as,
        ),
        'not_visible',
      )
      await db.expectError(
        db.rpc('friend_request_accept', { source_human_id: pending.humanId }, alice.as),
        'invalid_input',
      )
      expect(
        await count(db, 'public.notifications', 'recipient_human_id = $1', [pending.humanId]),
      ).toBe(0)
      expect(
        await count(db, 'public.conversation_members', 'human_id = $1', [pending.humanId]),
      ).toBe(0)
    })

    it('a pending Human holds no membership and cannot act as a Human', async () => {
      const group = await createGroup(db, alice, 'Alice Crew')
      const invite = await createInvite(db, group, alice)
      await db.expectError(db.rpc('group_create', { name: 'Mine' }, pending.as), 'not_a_human')
      await db.expectError(
        db.rpc('group_invite_join', { token: invite.token }, pending.as),
        'not_a_human',
      )
      await db.expectError(db.rpc('conversations_list', {}, pending.as), 'not_a_human')
      await db.expectError(
        db.rpc('friend_request_send', { target_human_id: alice.humanId }, pending.as),
        'not_a_human',
      )
      await db.expectError(
        db.rpc('post_create', { type: 'text', text: 'hi', audience: 'world' }, pending.as),
        'not_a_human',
      )
      // Previews are for anyone, but never claim membership for a pending viewer.
      const preview = await db.rpc<{ alreadyMember: boolean }>(
        'group_invite_preview',
        { token: invite.token },
        pending.as,
      )
      expect(preview.alreadyMember).toBe(false)
      expect(await count(db, 'public.group_members', 'human_id = $1', [pending.humanId])).toBe(0)
      // A pending Human sees no more of others than a visitor does.
      await db.expectError(
        db.rpc('profile_get', { handle: 'hidfriend' }, pending.as),
        'not_visible',
      )
    })
  })

  // -------------------------------------------------------------------------------------------------
  describe('Human Pass metadata is service-only', () => {
    it('metadata written by the service never reaches any client-readable surface', async () => {
      const user = await createUnclaimed(db)
      const started = await claimToVerifying(db, user.as, freshHandle('meta'))
      const marker = `SECRET-${started.humanId.slice(0, 8)}`
      await recordResult(db, started.humanId, 'verified', {
        risk_level: 'low',
        provider_reference: 'sess-meta',
        metadata: { secretMarker: marker, faceMatch: 0.99, documentNumber: 'X123' },
      })
      expect(
        await count(db, 'private.human_pass_metadata', "metadata ->> 'secretMarker' = $1", [
          marker,
        ]),
      ).toBe(1)

      const surfaces = [
        await db.rpc('claim_get', {}, user.as),
        await db.rpc('me_get', {}, user.as),
        await db.asRole(
          user.as,
          async (c) =>
            (await c.query('select to_jsonb(hp) as row from public.human_passes hp')).rows,
        ),
        await db.asRole(
          user.as,
          async (c) => (await c.query('select to_jsonb(h) as row from public.humans h')).rows,
        ),
      ]
      for (const surface of surfaces) {
        const text = JSON.stringify(surface)
        expect(text).not.toContain(marker)
        expect(text).not.toContain('X123')
        expect(text).not.toContain('faceMatch')
      }
      const columns = await scalar<string[]>(
        db,
        `array_agg(column_name::text) from information_schema.columns where table_schema = 'public' and table_name = 'human_passes'`,
      )
      expect(columns).not.toContain('metadata_private')
      expect(columns).not.toContain('metadata')

      const guest = await createGuest(db)
      for (const as of [user.as, alice.as, guest.as, 'visitor', 'service'] as RoleSpec[]) {
        await expectDenied(
          db.asRole(as, (c) => c.query('select * from private.human_pass_metadata')),
        )
        await expectDenied(db.asRole(as, (c) => c.query('select * from private.audit_log')))
      }
    })

    it('only the service records results; nobody edits passes or reviews directly', async () => {
      const user = await createUnclaimed(db)
      const started = await claimToVerifying(db, user.as, freshHandle('svc'))
      const guest = await createGuest(db)
      for (const as of [user.as, alice.as, guest.as, 'visitor'] as RoleSpec[]) {
        await db.expectError(
          db.rpc('human_pass_record_result', { human_id: started.humanId, status: 'verified' }, as),
          'forbidden',
        )
      }
      expect(await passStatusOf(db, started.humanId)).toBe('verifying')
      for (const as of [user.as, alice.as]) {
        await expectDenied(
          db.asRole(as, (c) => c.query("update public.human_passes set status = 'verified'")),
        )
        await expectDenied(
          db.asRole(as, (c) => c.query("update public.humans set human_pass_status = 'verified'")),
        )
        await expectDenied(
          db.asRole(as, (c) =>
            c.query("update public.identity_reviews set status = 'approved', resolved_at = now()"),
          ),
        )
        await expectDenied(
          db.asRole(as, (c) =>
            c.query(
              `insert into public.identity_reviews (human_id, kind, status, resolved_at) values ($1, 'help', 'approved', now())`,
              [started.humanId],
            ),
          ),
        )
      }
      await db.expectError(db.rpc('claim_complete', {}, user.as), 'verification_pending')
    })
  })

  // -------------------------------------------------------------------------------------------------
  describe('Claim is group-anchored while the flag is on', () => {
    it('a claim started while the flag was off cannot complete without a group once it is on', async () => {
      const user = await createUnclaimed(db)
      await setFlag(db, 'GROUP_ANCHORED_CLAIM_REQUIRED', false)
      let started: ClaimState
      try {
        started = await claimToVerifying(db, user.as, freshHandle('solo'), {})
        expect(started.intent).toBeNull()
      } finally {
        await setFlag(db, 'GROUP_ANCHORED_CLAIM_REQUIRED', true)
      }
      await recordResult(db, started.humanId, 'verified')
      await db.expectError(db.rpc('claim_complete', {}, user.as), 'invalid_input')
      expect(await statusOf(db, started.humanId)).toBe('pending')
      expect(await count(db, 'public.group_members', 'human_id = $1', [started.humanId])).toBe(0)
      // Choosing a group fixes it.
      await db.rpc('claim_start', { intent: 'start_group' }, user.as)
      const done = ClaimCompleteDtoSchema.parse(await db.rpc('claim_complete', {}, user.as))
      expect(done.groupId).not.toBeNull()
      expect(
        await count(
          db,
          'public.group_members',
          "human_id = $1 and status = 'active' and role = 'owner'",
          [started.humanId],
        ),
      ).toBe(1)
    })

    it('completion always yields an active membership and a conversation seat, label or not', async () => {
      const user = await createUnclaimed(db)
      const started = await claimToVerifying(db, user.as, freshHandle('nolabel'), {
        intent: 'start_group',
        group_label: '   ',
      })
      expect(started.groupLabel).toBeNull()
      await recordResult(db, started.humanId, 'verified')
      const done = ClaimCompleteDtoSchema.parse(await db.rpc('claim_complete', {}, user.as))
      expect(await scalar(db, 'name from public.groups where id = $1', [done.groupId])).toBeNull()
      expect(
        await count(db, 'public.group_members', "human_id = $1 and status = 'active'", [
          started.humanId,
        ]),
      ).toBe(1)
      expect(
        await count(db, 'public.conversation_members', 'conversation_id = $1 and human_id = $2', [
          done.conversationId,
          started.humanId,
        ]),
      ).toBe(1)
      expect(MeDtoSchema.parse(await db.rpc('me_get', {}, user.as)).roleKind).toBe('human')
    })

    it('a join_group claim whose invite or group is gone at completion fails atomically', async () => {
      const owner = await createHuman(db, { handle: freshHandle('own') })
      const group = await createGroup(db, owner, 'Vanishing')
      const invite = await createInvite(db, group, owner)

      const user = await createUnclaimed(db)
      const started = await claimToVerifying(db, user.as, freshHandle('join'), {
        intent: 'join_group',
        invite_token: invite.token,
      })
      await recordResult(db, started.humanId, 'verified')
      await db.rpc('group_invite_revoke', { invite_id: invite.inviteId }, owner.as)
      await db.expectError(db.rpc('claim_complete', {}, user.as), 'invite_invalid')
      expect(await statusOf(db, started.humanId)).toBe('pending')
      expect(await count(db, 'public.group_members', 'human_id = $1', [started.humanId])).toBe(0)
      expect(
        await count(db, 'private.audit_log', "action = 'claim_complete' and target_id = $1", [
          started.humanId,
        ]),
      ).toBe(0)

      const fresh = await createInvite(db, group, owner)
      await db.rpc('claim_start', { intent: 'join_group', invite_token: fresh.token }, user.as)
      await db.sql.query("update public.groups set status = 'archived' where id = $1", [
        group.groupId,
      ])
      await db.expectError(db.rpc('claim_complete', {}, user.as), 'invite_invalid')
      expect(await statusOf(db, started.humanId)).toBe('pending')
      expect(MeDtoSchema.parse(await db.rpc('me_get', {}, user.as)).roleKind).toBe('claiming')
    })
  })

  // -------------------------------------------------------------------------------------------------
  describe('Recovery and duplicate paths never activate a second Human', () => {
    it('an approved recovery or safety review is not a verification', async () => {
      for (const kind of ['recovery', 'safety']) {
        const user = await createUnclaimed(db)
        const started = await claimToVerifying(db, user.as, freshHandle(kind))
        await recordResult(db, started.humanId, 'rejected')
        const review = await db.rpc<Review>('identity_review_create', { kind }, user.as)
        await db.expectError(db.rpc('claim_complete', {}, user.as), 'verification_pending')
        // A person handles the recovery/safety case on the *existing* Human (spec §80); approving
        // it must not turn this pending row into a second Human.
        await resolveReview(db, review.id, 'approved')
        expect(ClaimStateDtoSchema.parse(await db.rpc('claim_get', {}, user.as)).status).not.toBe(
          'verified',
        )
        await db.expectError(db.rpc('claim_complete', {}, user.as), 'verification_required')
        expect(await statusOf(db, started.humanId)).toBe('pending')
        expect(await count(db, 'public.group_members', 'human_id = $1', [started.humanId])).toBe(0)
      }
    })

    it('an approved help or inconclusive review still verifies (spec §79)', async () => {
      for (const kind of ['help', 'inconclusive']) {
        const user = await createUnclaimed(db)
        const started = await claimToVerifying(db, user.as, freshHandle(kind))
        await recordResult(db, started.humanId, 'rejected')
        const review = await db.rpc<Review>('identity_review_create', { kind }, user.as)
        await resolveReview(db, review.id, 'approved')
        const done = ClaimCompleteDtoSchema.parse(await db.rpc('claim_complete', {}, user.as))
        expect(done.humanId).toBe(started.humanId)
        expect(await statusOf(db, started.humanId)).toBe('active')
      }
    })

    it('recording any result never changes humans.status, for pending and active Humans alike', async () => {
      const user = await createUnclaimed(db)
      const started = await claimToVerifying(db, user.as, freshHandle('any'))
      for (const status of ['unverified', 'verifying', 'verified', 'review_required', 'rejected']) {
        await recordResult(db, started.humanId, status)
        expect(await statusOf(db, started.humanId)).toBe('pending')
        expect(await passStatusOf(db, started.humanId)).toBe(status)
      }
      // The same on an active Human (re-verification) never demotes or duplicates anything.
      const before = await count(db, 'public.humans', 'true')
      await recordResult(db, alice.humanId, 'review_required', {
        duplicate_of_human_id: bob.humanId,
      })
      expect(await statusOf(db, alice.humanId)).toBe('active')
      expect(await count(db, 'public.humans', 'true')).toBe(before)
      await db.expectError(
        db.rpc('human_pass_record_result', { human_id: NIL_UUID, status: 'verified' }, 'service'),
        'invalid_input',
      )
    })

    it('reviews and results never create Humans, and a review cannot be opened for a foreign Human', async () => {
      const before = await count(db, 'public.humans', 'true')
      const aliceReviews = await count(db, 'public.identity_reviews', 'human_id = $1', [
        alice.humanId,
      ])
      const user = await createUnclaimed(db)
      await db.rpc('claim_start', { intent: 'start_group' }, user.as)
      const review = await db.rpc<Review>(
        'identity_review_create',
        { kind: 'duplicate', details: { humanId: alice.humanId } },
        user.as,
      )
      // The review lands on the caller's own pending Human, whatever the details say.
      expect(review.humanId).not.toBe(alice.humanId)
      expect(await count(db, 'public.identity_reviews', 'human_id = $1', [alice.humanId])).toBe(
        aliceReviews,
      )
      expect(await count(db, 'public.humans', 'true')).toBe(before + 1)
      // A self-opened duplicate review blocks the claimant, it does not help them.
      await db.rpc(
        'claim_set_identity',
        { display_name: 'S', handle: freshHandle('selfdup') },
        user.as,
      )
      await recordResult(db, review.humanId, 'verified')
      await db.expectError(db.rpc('claim_complete', {}, user.as), 'duplicate_human')
    })
  })
})
