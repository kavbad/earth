import { ClaimCompleteDtoSchema, ClaimStateDtoSchema } from '@earth/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  count,
  createGroup,
  createGuest,
  createHuman,
  createInvite,
  createUnclaimed,
  scalar,
  setFlag,
  type GroupFixture,
  type Human,
} from './fixtures'

const UNIQUE_VIOLATION = '23505'

interface ClaimState {
  status: string
  intent: string | null
  groupLabel: string | null
  identity: { displayName: string; handle: string; avatarUrl: string | null } | null
  verification: { status: string; sessionId?: string }
  humanId: string
}

async function humanIdOf(db: TestDb, userId: string): Promise<string | null> {
  return scalar<string | null>(db, 'id from public.humans where auth_user_id = $1', [userId])
}

async function recordVerified(db: TestDb, humanId: string): Promise<void> {
  await db.rpc(
    'human_pass_record_result',
    {
      human_id: humanId,
      status: 'verified',
      risk_level: 'low',
      provider: 'mock',
      provider_reference: `sess-${humanId.slice(0, 8)}`,
      metadata: { provider: 'mock', score: 0.99 },
      duplicate_of_human_id: null,
    },
    'service',
  )
}

describe('claim flow (spec §44–48, DB_API §1)', () => {
  let db: TestDb
  let owner: Human
  let group: GroupFixture
  let inviteToken: string

  beforeAll(async () => {
    db = await createTestDb()
    owner = await createHuman(db, { handle: 'owner', displayName: 'Owner' })
    group = await createGroup(db, owner, 'Weekend Crew')
    inviteToken = (await createInvite(db, group, owner)).token
  })

  afterAll(async () => {
    await db.drop()
  })

  it('only real credentials may start a claim', async () => {
    const guest = await createGuest(db)
    await db.expectError(
      db.rpc('claim_start', { intent: 'start_group' }, 'visitor'),
      'not_authenticated',
    )
    await db.expectError(
      db.rpc('claim_start', { intent: 'start_group' }, guest.as),
      'guest_not_allowed',
    )
    await db.expectError(db.rpc('claim_start', { intent: 'start_group' }, 'service'), 'forbidden')
    await db.expectError(db.rpc('claim_get', {}, 'visitor'), 'not_authenticated')
    const unclaimed = await createUnclaimed(db)
    await db.expectError(db.rpc('claim_get', {}, unclaimed.as), 'claim_not_pending')
    await db.expectError(db.rpc('claim_complete', {}, unclaimed.as), 'claim_not_pending')
    await db.expectError(
      db.rpc('claim_set_identity', { display_name: 'X', handle: 'xxx' }, unclaimed.as),
      'claim_not_pending',
    )
  })

  it('start_group: claim → identity → verification → Human + group + membership + conversation atomically', async () => {
    const user = await createUnclaimed(db)
    const started = ClaimStateDtoSchema.parse(
      await db.rpc(
        'claim_start',
        { intent: 'start_group', group_label: '  Weekend Crew  ' },
        user.as,
      ),
    )
    expect(started).toMatchObject({
      status: 'started',
      intent: 'start_group',
      groupLabel: 'Weekend Crew',
      identity: null,
      verification: { status: 'unverified' },
    })
    const humanId = await humanIdOf(db, user.userId)
    expect(humanId).toBe(started.humanId)
    expect(await scalar(db, 'status::text from public.humans where id = $1', [humanId])).toBe(
      'pending',
    )
    expect(
      await count(
        db,
        'public.auth_identities',
        "human_id = $1 and provider = 'supabase' and provider_subject = $2",
        [humanId, user.userId],
      ),
    ).toBe(1)
    expect(ClaimStateDtoSchema.parse(await db.rpc('claim_get', {}, user.as)).status).toBe('started')

    // Identity is required before completion; the flow is refused atomically until then.
    await db.expectError(db.rpc('claim_complete', {}, user.as), 'claim_identity_missing')
    expect(await scalar(db, 'status::text from public.humans where id = $1', [humanId])).toBe(
      'pending',
    )
    expect(await count(db, 'public.groups', 'created_by_human_id = $1', [humanId])).toBe(0)

    await db.expectError(
      db.rpc('claim_set_identity', { display_name: 'Maya', handle: 'ab' }, user.as),
      'handle_invalid',
    )
    await db.expectError(
      db.rpc('claim_set_identity', { display_name: 'Maya', handle: 'Owner' }, user.as),
      'handle_taken',
    )
    await db.expectError(
      db.rpc('claim_set_identity', { display_name: ' ', handle: 'maya' }, user.as),
      'invalid_input',
    )
    const withIdentity = ClaimStateDtoSchema.parse(
      await db.rpc('claim_set_identity', { display_name: 'Maya', handle: '@Maya' }, user.as),
    )
    expect(withIdentity.status).toBe('identity_set')
    expect(withIdentity.identity).toEqual({ displayName: 'Maya', handle: 'maya', avatarUrl: null })
    // Editing the identity again keeps the same handle without a handle_taken error.
    expect(
      ClaimStateDtoSchema.parse(
        await db.rpc('claim_set_identity', { display_name: 'Maya M', handle: 'maya' }, user.as),
      ).identity?.displayName,
    ).toBe('Maya M')

    await db.expectError(db.rpc('claim_complete', {}, user.as), 'verification_required')

    const begun = await db.rpc<{ humanPassId: string; status: string }>(
      'claim_verification_begin',
      { provider: 'mock' },
      user.as,
    )
    expect(begun.status).toBe('verifying')
    expect(ClaimStateDtoSchema.parse(await db.rpc('claim_get', {}, user.as))).toMatchObject({
      status: 'verifying',
      verification: { status: 'verifying' },
    })
    await db.expectError(db.rpc('claim_complete', {}, user.as), 'verification_pending')

    await recordVerified(db, started.humanId)
    const verified = ClaimStateDtoSchema.parse(await db.rpc('claim_get', {}, user.as))
    expect(verified.status).toBe('verified')
    expect(verified.verification).toEqual({
      status: 'verified',
      sessionId: `sess-${started.humanId.slice(0, 8)}`,
    })
    // Human Pass metadata never reaches public tables.
    expect(await count(db, 'private.human_pass_metadata', "metadata ->> 'provider' = 'mock'")).toBe(
      1,
    )
    expect(
      await count(db, 'public.human_passes', 'human_id = $1 and verified_at is not null', [
        started.humanId,
      ]),
    ).toBe(1)

    const complete = ClaimCompleteDtoSchema.parse(await db.rpc('claim_complete', {}, user.as))
    expect(complete.humanId).toBe(started.humanId)
    expect(await scalar(db, 'status::text from public.humans where id = $1', [humanId])).toBe(
      'active',
    )
    expect(
      await scalar(db, 'claimed_at is not null from public.humans where id = $1', [humanId]),
    ).toBe(true)
    expect(await scalar(db, 'name from public.groups where id = $1', [complete.groupId])).toBe(
      'Weekend Crew',
    )
    expect(
      await scalar(db, 'member_count from public.groups where id = $1', [complete.groupId]),
    ).toBe(1)
    expect(
      await count(
        db,
        'public.group_members',
        "group_id = $1 and human_id = $2 and role = 'owner' and status = 'active'",
        [complete.groupId, humanId],
      ),
    ).toBe(1)
    expect(
      await scalar(db, 'group_id from public.conversations where id = $1', [
        complete.conversationId,
      ]),
    ).toBe(complete.groupId)
    expect(
      await count(db, 'public.conversation_members', 'conversation_id = $1 and human_id = $2', [
        complete.conversationId,
        humanId,
      ]),
    ).toBe(1)
    expect(
      await count(db, 'private.audit_log', "action = 'claim_complete' and target_id = $1", [
        humanId,
      ]),
    ).toBe(1)

    expect(ClaimStateDtoSchema.parse(await db.rpc('claim_get', {}, user.as)).status).toBe('claimed')
    expect((await db.rpc<{ roleKind: string }>('me_get', {}, user.as)).roleKind).toBe('human')
    await db.expectError(db.rpc('claim_complete', {}, user.as), 'claim_not_pending')
    await db.expectError(
      db.rpc('claim_start', { intent: 'start_group' }, user.as),
      'duplicate_human',
    )
    await db.expectError(
      db.rpc('claim_set_identity', { display_name: 'X', handle: 'xyz' }, user.as),
      'claim_not_pending',
    )
  })

  it('join_group: validates the invite at start, stores its hash and joins atomically at completion', async () => {
    const user = await createUnclaimed(db)
    await db.expectError(db.rpc('claim_start', { intent: 'join_group' }, user.as), 'invalid_input')
    await db.expectError(
      db.rpc('claim_start', { intent: 'join_group', invite_token: 'nope' }, user.as),
      'invite_invalid',
    )
    await db.expectError(db.rpc('claim_start', { intent: 'nonsense' }, user.as), 'invalid_input')

    const started = ClaimStateDtoSchema.parse(
      await db.rpc('claim_start', { intent: 'join_group', invite_token: inviteToken }, user.as),
    )
    expect(started).toMatchObject({
      status: 'started',
      intent: 'join_group',
      groupLabel: 'Weekend Crew',
    })
    expect(started).not.toHaveProperty('inviteToken')
    expect(
      await scalar(
        db,
        'claim_invite_token_hash = earth.sha256_hex($2) from public.humans where id = $1',
        [started.humanId, inviteToken],
      ),
    ).toBe(true)

    await db.rpc('claim_set_identity', { display_name: 'Xavier', handle: 'xavier' }, user.as)
    await db.rpc('claim_verification_begin', { provider: 'mock' }, user.as)
    await recordVerified(db, started.humanId)
    const complete = ClaimCompleteDtoSchema.parse(await db.rpc('claim_complete', {}, user.as))
    expect(complete).toEqual({
      humanId: started.humanId,
      groupId: group.groupId,
      conversationId: group.conversationId,
    })
    expect(
      await count(
        db,
        'public.group_members',
        "group_id = $1 and human_id = $2 and role = 'member' and status = 'active'",
        [group.groupId, started.humanId],
      ),
    ).toBe(1)
    expect(
      await count(db, 'public.conversation_members', 'conversation_id = $1 and human_id = $2', [
        group.conversationId,
        started.humanId,
      ]),
    ).toBe(1)
    expect(
      await scalar(
        db,
        'use_count from public.group_invites where token_hash = earth.sha256_hex($1)',
        [inviteToken],
      ),
    ).toBe(1)
    expect(
      await scalar(db, 'claim_invite_token_hash from public.humans where id = $1', [
        started.humanId,
      ]),
    ).toBeNull()
    // Joining a group never creates friendship (spec §23).
    expect(
      await count(db, 'public.relationships', 'source_human_id = $1 or target_human_id = $1', [
        started.humanId,
      ]),
    ).toBe(0)
    expect(await scalar(db, 'member_count from public.groups where id = $1', [group.groupId])).toBe(
      2,
    )
  })

  it('claim_start on a pending Human updates the intent; an invalidated invite fails completion atomically', async () => {
    const user = await createUnclaimed(db)
    const first = ClaimStateDtoSchema.parse(
      await db.rpc('claim_start', { intent: 'start_group', group_label: 'Draft' }, user.as),
    )
    const token = (await createInvite(db, group, owner, { maxUses: 1 })).token
    const second = ClaimStateDtoSchema.parse(
      await db.rpc('claim_start', { intent: 'join_group', invite_token: token }, user.as),
    )
    expect(second.humanId).toBe(first.humanId)
    expect(second).toMatchObject({ intent: 'join_group', groupLabel: 'Weekend Crew' })
    expect(await count(db, 'public.humans', 'auth_user_id = $1', [user.userId])).toBe(1)

    await db.rpc('claim_set_identity', { display_name: 'Sam', handle: 'sam' }, user.as)
    await recordVerified(db, first.humanId)
    // The invite gets used up by someone else before completion.
    const other = await createHuman(db, { handle: 'other' })
    await db.rpc('group_invite_join', { token }, other.as)
    await db.expectError(db.rpc('claim_complete', {}, user.as), 'invite_exhausted')
    expect(await scalar(db, 'status::text from public.humans where id = $1', [first.humanId])).toBe(
      'pending',
    )
    expect(await count(db, 'public.group_members', 'human_id = $1', [first.humanId])).toBe(0)
    expect(
      await count(db, 'private.audit_log', "action = 'claim_complete' and target_id = $1", [
        first.humanId,
      ]),
    ).toBe(0)
    // Switching back to start_group completes fine.
    await db.rpc('claim_start', { intent: 'start_group', group_label: 'Fresh' }, user.as)
    const done = ClaimCompleteDtoSchema.parse(await db.rpc('claim_complete', {}, user.as))
    expect(await scalar(db, 'name from public.groups where id = $1', [done.groupId])).toBe('Fresh')
  })

  it('GROUP_ANCHORED_CLAIM_REQUIRED off allows a claim without a group', async () => {
    const gated = await createUnclaimed(db)
    await db.expectError(db.rpc('claim_start', {}, gated.as), 'invalid_input')
    await setFlag(db, 'GROUP_ANCHORED_CLAIM_REQUIRED', false)
    try {
      const user = await createUnclaimed(db)
      const started = await db.rpc<ClaimState>('claim_start', {}, user.as)
      expect(started.intent).toBeNull()
      expect(started.status).toBe('started')
      await db.rpc('claim_set_identity', { display_name: 'Solo', handle: 'solo' }, user.as)
      await recordVerified(db, started.humanId)
      const done = await db.rpc<{
        humanId: string
        groupId: string | null
        conversationId: string | null
      }>('claim_complete', {}, user.as)
      expect(done).toEqual({ humanId: started.humanId, groupId: null, conversationId: null })
      expect(
        await scalar(db, 'status::text from public.humans where id = $1', [started.humanId]),
      ).toBe('active')
      expect(await count(db, 'public.group_members', 'human_id = $1', [started.humanId])).toBe(0)
    } finally {
      await setFlag(db, 'GROUP_ANCHORED_CLAIM_REQUIRED', true)
    }
  })

  it('requires a verified pass or an approved review, and refuses while a duplicate review is open', async () => {
    const user = await createUnclaimed(db)
    const state = await db.rpc<ClaimState>('claim_start', { intent: 'start_group' }, user.as)
    await db.rpc('claim_set_identity', { display_name: 'Dup', handle: 'dup' }, user.as)
    await db.rpc('claim_verification_begin', { provider: 'vendor' }, user.as)

    // review_required with a duplicate candidate → open duplicate review → duplicate_human.
    const reviewed = ClaimStateDtoSchema.parse(
      await db.rpc(
        'human_pass_record_result',
        {
          human_id: state.humanId,
          status: 'review_required',
          duplicate_of_human_id: owner.humanId,
          metadata: { reason: 'face_match' },
        },
        'service',
      ),
    )
    expect(reviewed.status).toBe('verifying')
    expect(reviewed.verification.status).toBe('review_required')
    expect(
      await count(
        db,
        'public.identity_reviews',
        "human_id = $1 and kind = 'duplicate' and status = 'open' and duplicate_of_human_id = $2",
        [state.humanId, owner.humanId],
      ),
    ).toBe(1)
    await db.expectError(db.rpc('claim_complete', {}, user.as), 'duplicate_human')
    // Recording the same result twice does not open a second review.
    await db.rpc(
      'human_pass_record_result',
      { human_id: state.humanId, status: 'review_required', duplicate_of_human_id: owner.humanId },
      'service',
    )
    expect(
      await count(db, 'public.identity_reviews', "human_id = $1 and kind = 'duplicate'", [
        state.humanId,
      ]),
    ).toBe(1)

    // The review is rejected (it really was a duplicate attempt): still not claimable.
    await db.sql.query(
      "update public.identity_reviews set status = 'rejected', resolved_at = now() where human_id = $1",
      [state.humanId],
    )
    await db.expectError(db.rpc('claim_complete', {}, user.as), 'verification_pending')

    // A rejected pass needs help: an approved review (spec §79) is enough even without a verified pass.
    await db.rpc(
      'human_pass_record_result',
      { human_id: state.humanId, status: 'rejected' },
      'service',
    )
    await db.expectError(db.rpc('claim_complete', {}, user.as), 'verification_required')
    const help = await db.rpc<{ id: string; kind: string; status: string }>(
      'identity_review_create',
      { kind: 'help', details: { note: 'camera broken' } },
      user.as,
    )
    expect(help).toMatchObject({ kind: 'help', status: 'open' })
    await db.expectError(db.rpc('claim_complete', {}, user.as), 'verification_pending')
    await db.sql.query(
      "update public.identity_reviews set status = 'approved', resolved_at = now() where id = $1",
      [help.id],
    )
    expect(ClaimStateDtoSchema.parse(await db.rpc('claim_get', {}, user.as)).status).toBe(
      'verified',
    )
    const done = ClaimCompleteDtoSchema.parse(await db.rpc('claim_complete', {}, user.as))
    expect(done.humanId).toBe(state.humanId)
  })

  it('human_pass_record_result is service-only and validates its inputs', async () => {
    const user = await createUnclaimed(db)
    const state = await db.rpc<ClaimState>('claim_start', { intent: 'start_group' }, user.as)
    for (const as of [user.as, owner.as, 'visitor'] as RoleSpec[]) {
      await db.expectError(
        db.rpc('human_pass_record_result', { human_id: state.humanId, status: 'verified' }, as),
        'forbidden',
      )
    }
    await db.expectError(
      db.rpc(
        'human_pass_record_result',
        { human_id: '00000000-0000-0000-0000-000000000000', status: 'verified' },
        'service',
      ),
      'invalid_input',
    )
    await db.expectError(
      db.rpc(
        'human_pass_record_result',
        { human_id: state.humanId, status: 'verified', risk_level: 'extreme' },
        'service',
      ),
      'invalid_input',
    )
    await db.expectError(
      db.rpc(
        'human_pass_record_result',
        { human_id: state.humanId, status: 'verified', duplicate_of_human_id: state.humanId },
        'service',
      ),
      'invalid_input',
    )
    // A result never activates the Human by itself.
    await recordVerified(db, state.humanId)
    expect(await scalar(db, 'status::text from public.humans where id = $1', [state.humanId])).toBe(
      'pending',
    )
    expect(
      await scalar(db, 'human_pass_status::text from public.humans where id = $1', [state.humanId]),
    ).toBe('verified')
    // Own pass and reviews are readable by the Human; private metadata is not reachable.
    const passes = await db.asRole(user.as, (c) =>
      c.query('select status from public.human_passes'),
    )
    expect(passes.rows).toEqual([{ status: 'verified' }])
    const foreign = await db.asRole(owner.as, (c) =>
      c.query('select status from public.human_passes where human_id = $1', [state.humanId]),
    )
    expect(foreign.rowCount).toBe(0)
    await expect(
      db.asRole(user.as, (c) => c.query('select * from private.human_pass_metadata')),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('identity_review_create validates kinds and is rate limited', async () => {
    const user = await createUnclaimed(db)
    await db.expectError(
      db.rpc('identity_review_create', { kind: 'help' }, user.as),
      'claim_not_pending',
    )
    await db.rpc('claim_start', { intent: 'start_group' }, user.as)
    await db.expectError(
      db.rpc('identity_review_create', { kind: 'bogus' }, user.as),
      'invalid_input',
    )
    await db.expectError(
      db.rpc('identity_review_create', { kind: 'help', details: '[1]' }, user.as),
      'invalid_input',
    )
    await db.expectError(
      db.rpc('identity_review_create', { kind: 'help' }, 'visitor'),
      'not_authenticated',
    )
    for (const kind of ['duplicate', 'inconclusive', 'help', 'safety', 'recovery']) {
      expect(
        (await db.rpc<{ kind: string }>('identity_review_create', { kind }, user.as)).kind,
      ).toBe(kind)
    }
    await db.expectError(
      db.rpc('identity_review_create', { kind: 'help' }, user.as),
      'rate_limited',
    )
    const mine = await db.asRole(user.as, (c) =>
      c.query('select kind from public.identity_reviews'),
    )
    expect(mine.rowCount).toBe(5)
    // Active Humans may also open reviews (safety, recovery).
    expect(
      (await db.rpc<{ kind: string }>('identity_review_create', { kind: 'safety' }, owner.as)).kind,
    ).toBe('safety')
  })

  it('never lets one auth user own two Humans, even by hand', async () => {
    await expect(
      db.sql.query(
        `insert into public.humans (status, auth_user_id, claimed_at) values ('active', $1, now())`,
        [owner.userId],
      ),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION })
  })
})
