/**
 * `metrics_compute_daily(day)` (spec §13, PART XVII §98–§101; DB_API §8; 0810) over a synthetic
 * day D = 2026-06-15, built through the RPCs wherever the RPC exists (claim flow, groups, rooms,
 * visibility changes, guest sessions, events) and re-dated as the service; messages are service
 * inserts because the messages trigger keeps `created_at` immutable. Every metric has a known
 * expected value; the job is idempotent per (day, metric, dimensions); `rooms.max_visibility` is
 * monotonic.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type TestDb } from '../harness'
import {
  PERMISSION_DENIED,
  addMember,
  count,
  createGroup,
  createGuest,
  createGuestSession,
  createInvite,
  createRoomInvite,
  createUnclaimed,
  event,
  human,
  metricKey,
  metricMap,
  roomRow,
  scalar,
  setCreatedAt,
  sqlstate,
  startGroupRoom,
  startStandaloneRoom,
  track,
  visitorId,
  type GroupFixture,
  type Human,
  type MetricRow,
} from './fixtures'

const D = '2026-06-15'

function dayOffset(days: number): string {
  const date = new Date(`${D}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

const at = (dayShift: number, time = '12:00'): string => `${dayOffset(dayShift)}T${time}:00Z`

const EXPECTED_ROWS = 13

describe('metrics_compute_daily (spec §98–§101; DB_API §8)', () => {
  let db: TestDb
  let hostA: Human
  let hostB: Human
  let hostC: Human
  let r1: string
  let metrics: Map<string, MetricRow>

  const compute = (day: string | null) =>
    db.rpc<{ day: string; computedAt: string; metrics: unknown[] }>(
      'metrics_compute_daily',
      { day },
      'service',
    )

  async function setClaim(
    h: Human,
    intent: 'start_group' | 'join_group' | null,
    claimedAt: string,
  ): Promise<void> {
    await db.sql.query(
      'update public.humans set claim_intent = $2, claimed_at = $3 where id = $1',
      [h.humanId, intent, claimedAt],
    )
  }

  async function groupAt(owner: Human, name: string, createdAt: string): Promise<GroupFixture> {
    const group = await createGroup(db, owner, name)
    await setCreatedAt(db, 'public.groups', group.groupId, createdAt)
    await db.sql.query(
      'update public.group_members set joined_at = $3 where group_id = $1 and human_id = $2',
      [group.groupId, owner.humanId, createdAt],
    )
    return group
  }

  async function memberAt(
    group: GroupFixture,
    member: Human,
    joinedAt: string,
    leftAt: string | null = null,
  ): Promise<void> {
    await addMember(db, group, member)
    await db.sql.query(
      'update public.group_members set joined_at = $3 where group_id = $1 and human_id = $2',
      [group.groupId, member.humanId, joinedAt],
    )
    if (leftAt !== null) {
      await db.sql.query(
        `update public.group_members set status = 'left', left_at = $3 where group_id = $1 and human_id = $2`,
        [group.groupId, member.humanId, leftAt],
      )
    }
  }

  async function messageAt(
    conversationId: string,
    sender: Human,
    createdAt: string,
    type: 'text' | 'system' = 'text',
  ): Promise<void> {
    await db.sql.query(
      `insert into public.messages (conversation_id, sender_human_id, type, text, created_at) values ($1, $2, $3::public.message_type, $4, $5)`,
      [
        conversationId,
        sender.humanId,
        type,
        type === 'system' ? 'Someone joined' : 'hello',
        createdAt,
      ],
    )
  }

  async function eventAt(
    as: Human | 'visitor',
    name: string,
    properties: Record<string, unknown>,
    createdAt: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const marker = randomUUID()
    await track(
      db,
      [event(name, { ...properties, marker }, extra)],
      as === 'visitor' ? 'visitor' : as.as,
    )
    await db.sql.query(
      `update public.analytics_events set created_at = $2 where properties ->> 'marker' = $1`,
      [marker, createdAt],
    )
  }

  /** Full claim flow (DB_API §1) for a fresh credential; returns the active Human. */
  async function claim(
    handle: string,
    intent: 'start_group' | 'join_group',
    option: { groupLabel?: string; inviteToken?: string },
  ): Promise<Human> {
    const user = await createUnclaimed(db)
    const started = await db.rpc<{ humanId: string }>(
      'claim_start',
      { intent, group_label: option.groupLabel ?? null, invite_token: option.inviteToken ?? null },
      user.as,
    )
    await db.rpc('claim_set_identity', { display_name: handle, handle }, user.as)
    await db.rpc('claim_verification_begin', { provider: 'mock' }, user.as)
    await db.rpc(
      'human_pass_record_result',
      {
        human_id: started.humanId,
        status: 'verified',
        risk_level: 'low',
        provider: 'mock',
        provider_reference: `sess-${handle}`,
        metadata: { provider: 'mock' },
        duplicate_of_human_id: null,
      },
      'service',
    )
    await db.rpc('claim_complete', {}, user.as)
    return {
      userId: user.userId,
      humanId: started.humanId,
      handle,
      displayName: handle,
      as: user.as,
    }
  }

  beforeAll(async () => {
    db = await createTestDb()
    hostA = await human(db, 'HostA')
    hostB = await human(db, 'HostB')
    hostC = await human(db, 'HostC')

    // --- Groups: activation cohorts D (1 of 4) and D-7 (1 of 2); temporary groups never count ---
    const ga = await groupAt(hostA, 'GA', at(0, '09:00'))
    const gb = await groupAt(hostB, 'GB', at(0, '09:30'))
    const gc = await groupAt(hostC, 'GC', at(0, '10:00'))
    const gd = await groupAt(hostA, 'GD', at(0, '10:30'))
    const gf = await groupAt(hostB, 'GF', at(-7, '09:00'))
    const gg = await groupAt(hostC, 'GG', at(-7, '09:30'))
    const m1 = await human(db, 'M1')
    const m2 = await human(db, 'M2')
    const m3 = await human(db, 'M3')
    const m4 = await human(db, 'M4')
    const m5 = await human(db, 'M5')
    const m6 = await human(db, 'M6')
    const m7 = await human(db, 'M7')
    const m8 = await human(db, 'M8')
    await memberAt(ga, m1, at(1))
    await memberAt(ga, m2, at(3)) // GA: 3 by D+7 → activated
    await memberAt(gb, m3, at(1)) // GB: 2 → not
    await memberAt(gc, m4, at(2))
    await memberAt(gc, m5, at(9)) // GC: third member after the cutoff → not
    await memberAt(gd, m6, at(1))
    await memberAt(gd, m7, at(2), at(5)) // GD: left before the cutoff → not
    await memberAt(gf, m7, at(-6))
    await memberAt(gf, m8, at(-5)) // GF (cohort D-7): activated
    // GE: a temporary group (New chat) with 3 members, created on D — excluded by kind.
    const ge = await db.rpc<{ id: string; groupId: string }>(
      'conversation_group_create',
      { human_ids: [m1.humanId, m2.humanId] },
      hostA.as,
    )
    await setCreatedAt(db, 'public.groups', ge.groupId, at(0, '11:00'))
    expect(await scalar(db, 'kind::text from public.groups where id = $1', [ge.groupId])).toBe(
      'temporary',
    )

    // --- Humans claimed on D through the real claim flow (h1 start, h2 join) plus re-dated rows ---
    const h1 = await claim('seedone', 'start_group', { groupLabel: 'Seeded Crew' })
    const ggInvite = await createInvite(db, gg, hostC)
    const h2 = await claim('seedtwo', 'join_group', { inviteToken: ggInvite.token })
    const h3 = await human(db, 'H3')
    const h4 = await human(db, 'H4')
    const h5 = await human(db, 'H5')
    await setClaim(h1, 'start_group', at(0, '10:00'))
    await setClaim(h2, 'join_group', at(0, '11:00'))
    await db.sql.query(
      'update public.group_members set joined_at = $3 where group_id = $1 and human_id = $2',
      [gg.groupId, h2.humanId, at(0, '11:00')],
    ) // GG: 2 at the cutoff → not
    await setClaim(h3, 'join_group', at(0, '12:00'))
    await setClaim(h4, 'join_group', at(-1, '12:00')) // outside D
    await setClaim(h5, 'start_group', at(0, '13:00'))
    expect(await scalar(db, 'claim_intent from public.humans where id = $1', [h1.humanId])).toBe(
      'start_group',
    )

    // --- claim_started: 4 visitors (one twice) + one Claiming Human without a visitor id = 5 ---
    const v1 = visitorId()
    await eventAt(
      'visitor',
      'claim_started',
      { entry: 'public_world', hasGroupInvite: false },
      at(0, '08:00'),
      { anonymousVisitorId: v1 },
    )
    await eventAt(
      'visitor',
      'claim_started',
      { entry: 'group_invite', hasGroupInvite: true },
      at(0, '08:05'),
      { anonymousVisitorId: v1 },
    )
    for (const time of ['08:10', '08:20', '08:30']) {
      await eventAt(
        'visitor',
        'claim_started',
        { entry: 'public_world', hasGroupInvite: false },
        at(0, time),
        { anonymousVisitorId: visitorId() },
      )
    }
    await eventAt(h4, 'claim_started', { entry: 'launch', hasGroupInvite: false }, at(0, '08:40'))
    await eventAt(
      'visitor',
      'claim_started',
      { entry: 'launch', hasGroupInvite: false },
      at(-1, '08:00'),
      { anonymousVisitorId: visitorId() },
    )
    await eventAt(
      'visitor',
      'claim_started',
      { entry: 'launch', hasGroupInvite: false },
      at(1, '08:00'),
      { anonymousVisitorId: visitorId() },
    )

    // --- Second group cohort D-30: s1 (2 persistent) of s1..s4 ---
    const gh = await groupAt(hostB, 'GH', at(-25))
    const gi = await groupAt(hostC, 'GI', at(-25))
    const s1 = await human(db, 'S1')
    const s2 = await human(db, 'S2')
    const s3 = await human(db, 'S3')
    const s4 = await human(db, 'S4')
    const s5 = await human(db, 'S5')
    for (const s of [s1, s2, s3, s4]) await setClaim(s, 'join_group', at(-30, '10:00'))
    await setClaim(s5, 'join_group', at(-29, '10:00')) // outside the cohort
    await memberAt(gh, s1, at(-20))
    await memberAt(gi, s1, at(-20))
    await memberAt(gh, s2, at(-20))
    await memberAt(gh, s3, at(-20))
    const temporary = await db.rpc<{ groupId: string }>(
      'conversation_group_create',
      { human_ids: [s3.humanId, s2.humanId] },
      hostB.as,
    )
    await setCreatedAt(db, 'public.groups', temporary.groupId, at(-20))
    await memberAt(gh, s4, at(-20))
    await memberAt(gi, s4, at(-20), at(-1)) // left before the end of D
    await memberAt(gi, s5, at(-20))
    await memberAt(gh, s5, at(-20))

    // --- Messages: GA 4 on D (+1 system, +D-1, +D-3), GB 2 on D (+D-2), GF on D-6/-5/-4, one DM on D ---
    for (const time of ['09:00', '10:00', '11:00', '12:00'])
      await messageAt(ga.conversationId, hostA, at(0, time))
    await messageAt(ga.conversationId, hostA, at(0, '12:30'), 'system')
    await messageAt(ga.conversationId, m1, at(-1))
    await messageAt(ga.conversationId, m1, at(-3))
    await messageAt(gb.conversationId, hostB, at(0, '09:00'))
    await messageAt(gb.conversationId, m3, at(0, '09:05'))
    await messageAt(gb.conversationId, hostB, at(-2))
    await messageAt(gf.conversationId, hostB, at(-6))
    await messageAt(gf.conversationId, m7, at(-5))
    await messageAt(gf.conversationId, m8, at(-4))
    const dm = await db.rpc<{ id: string }>(
      'conversation_direct_get_or_create',
      { other_human_id: hostB.humanId },
      hostA.as,
    )
    await messageAt(dm.id, hostA, at(0, '13:00'))

    // --- Rooms: R1 group room widened to friends then narrowed back; R2 standalone; R3 group; R4 on D-1 ---
    r1 = (await startGroupRoom(db, hostA, ga)).room.id
    await db.rpc('room_set_visibility', { room_id: r1, visibility: 'friends' }, hostA.as)
    const r2 = (await startStandaloneRoom(db, hostB)).room.id
    const r3 = (await startGroupRoom(db, hostB, gb)).room.id
    const r4 = (await startStandaloneRoom(db, hostC)).room.id
    await setCreatedAt(db, 'public.rooms', r1, at(0, '14:00'))
    await setCreatedAt(db, 'public.rooms', r2, at(0, '15:00'))
    await setCreatedAt(db, 'public.rooms', r3, at(0, '16:00'))
    await setCreatedAt(db, 'public.rooms', r4, at(-1, '16:00'))

    // --- Guests: gA on D in R1 and on D-2 in R2 (repeat), gB on D in R2, gC on D-10 in R1 ---
    const inviteR1 = await createRoomInvite(db, r1, hostA)
    const inviteR2 = await createRoomInvite(db, r2, hostB)
    const gA = await createGuest(db)
    const gB = await createGuest(db)
    const gC = await createGuest(db)
    const gA1 = (await createGuestSession(db, gA, inviteR1.token, 'Sam')).guestSessionId
    const gA2 = (await createGuestSession(db, gA, inviteR2.token, 'Sam')).guestSessionId
    const gB1 = (await createGuestSession(db, gB, inviteR2.token, 'Kim')).guestSessionId
    const gC1 = (await createGuestSession(db, gC, inviteR1.token, 'Lee')).guestSessionId
    await setCreatedAt(db, 'public.guest_sessions', gA1, at(0, '09:00'))
    await setCreatedAt(db, 'public.guest_sessions', gA2, at(-2, '09:00'))
    await setCreatedAt(db, 'public.guest_sessions', gB1, at(0, '10:00'))
    await setCreatedAt(db, 'public.guest_sessions', gC1, at(-10, '10:00'))
    await db.rpc('room_set_visibility', { room_id: r1, visibility: 'group' }, hostA.as)
    // h1's credential was a Guest in R2 two days before claiming (Guest → Human via the tables).
    await db.sql.query(
      `insert into public.guest_sessions (room_id, auth_user_id, display_name, session_secret_hash, created_at, expires_at)
       values ($1, $2, 'Seed', earth.sha256_hex('seed-secret'), $3, $4)`,
      [r2, h1.userId, at(-2, '10:00'), at(-2, '12:00')],
    )
    // h2 converted per its human_claimed event; h3 names an unknown session; h5 a malformed one.
    await eventAt(
      h2,
      'human_claimed',
      { intent: 'join_group', guestSessionId: gB1, durationMs: 1200 },
      at(0, '11:01'),
    )
    await eventAt(
      h3,
      'human_claimed',
      { intent: 'join_group', guestSessionId: randomUUID(), durationMs: 900 },
      at(0, '12:01'),
    )
    await eventAt(
      h5,
      'human_claimed',
      { intent: 'start_group', guestSessionId: 'not-a-uuid', durationMs: 800 },
      at(0, '13:01'),
    )
    await eventAt(
      h4,
      'human_claimed',
      { intent: 'join_group', guestSessionId: gB1, durationMs: 700 },
      at(-1, '12:01'),
    )

    // --- Scope switches: 3 by h1 + 1 by h3 on D; one on D-1 ---
    for (const time of ['15:00', '15:01', '15:02'])
      await eventAt(
        h1,
        'scope_changed',
        { from: 'friends', to: 'city', surface: 'home' },
        at(0, time),
      )
    await eventAt(
      h3,
      'scope_changed',
      { from: 'city', to: 'world', surface: 'live' },
      at(0, '16:00'),
    )
    await eventAt(
      h1,
      'scope_changed',
      { from: 'world', to: 'friends', surface: 'earth' },
      at(-1, '16:00'),
    )

    const result = await compute(D)
    expect(result.day).toBe(D)
    expect(result.metrics).toHaveLength(EXPECTED_ROWS)
    metrics = await metricMap(db, D)
  })

  afterAll(async () => {
    await db.drop()
  })

  const row = (metric: string, dimensions: Record<string, unknown> = {}): MetricRow => {
    const found = metrics.get(metricKey(metric, dimensions))
    if (found === undefined) throw new Error(`missing metric ${metricKey(metric, dimensions)}`)
    return found
  }

  it('writes exactly one row per metric and cohort for the day', () => {
    expect([...metrics.keys()].sort()).toEqual(
      [
        metricKey('group_seed_rate'),
        metricKey('humans_per_seed'),
        metricKey('group_activation_rate', { cohort: D }),
        metricKey('group_activation_rate', { cohort: dayOffset(-7) }),
        metricKey('second_group_rate', { cohort: dayOffset(-30) }),
        metricKey('messages_per_active_group'),
        metricKey('groups_active_3_days_week'),
        metricKey('rooms_started'),
        metricKey('rooms_opened_beyond_group'),
        metricKey('guest_joins'),
        metricKey('repeat_guests'),
        metricKey('guest_to_human_conversions'),
        metricKey('scope_switches'),
      ].sort(),
    )
    expect(metrics.size).toBe(EXPECTED_ROWS)
  })

  it('group_seed_rate = Humans claimed ÷ distinct claim-intent Visitors (4 ÷ 5)', () => {
    expect(row('group_seed_rate')).toMatchObject({
      value: 0.8,
      details: { humansClaimed: 4, claimIntentVisitors: 5 },
    })
  })

  it('humans_per_seed = joined ÷ started (2 ÷ 2)', () => {
    expect(row('humans_per_seed')).toMatchObject({ value: 1, details: { joined: 2, started: 2 } })
  })

  it('group_activation_rate for cohorts D (1 of 4) and D-7 (1 of 2), persistent groups only', () => {
    expect(row('group_activation_rate', { cohort: D })).toMatchObject({
      value: 0.25,
      details: { groupsCreated: 4, groupsActivated: 1, final: true },
    })
    expect(row('group_activation_rate', { cohort: dayOffset(-7) })).toMatchObject({
      value: 0.5,
      details: { groupsCreated: 2, groupsActivated: 1, final: true },
    })
  })

  it('second_group_rate for the cohort claimed 30 days earlier (1 of 4)', () => {
    expect(row('second_group_rate', { cohort: dayOffset(-30) })).toMatchObject({
      value: 0.25,
      details: { humansClaimed: 4, withSecondGroup: 1 },
    })
  })

  it('messages_per_active_group counts non-system group messages (6 ÷ 2)', () => {
    expect(row('messages_per_active_group')).toMatchObject({
      value: 3,
      details: { messages: 6, activeGroups: 2 },
    })
  })

  it('groups_active_3_days_week counts groups with messages on ≥ 3 days of the trailing week (GA, GF)', () => {
    expect(row('groups_active_3_days_week')).toMatchObject({
      value: 2,
      details: { windowStart: dayOffset(-6), windowEnd: D, groups: 2 },
    })
  })

  it('rooms_started and rooms_opened_beyond_group (3 rooms; R1 widened then narrowed, R2 friends)', () => {
    expect(row('rooms_started')).toMatchObject({
      value: 3,
      details: { rooms: 3, byContextType: { group: 2, standalone: 1 } },
    })
    expect(row('rooms_opened_beyond_group')).toMatchObject({
      value: 2,
      details: { rooms: 2, groupRooms: 1, roomsStarted: 3 },
    })
  })

  it('guest_joins, repeat_guests and guest_to_human_conversions', () => {
    expect(row('guest_joins')).toMatchObject({ value: 2, details: { guestSessions: 2, rooms: 2 } })
    expect(row('repeat_guests')).toMatchObject({
      value: 1,
      details: { repeatGuests: 1, guestsInWindow: 3, windowStart: dayOffset(-6), windowEnd: D },
    })
    expect(row('guest_to_human_conversions')).toMatchObject({
      value: 2,
      details: { conversions: 2, humansClaimed: 4 },
    })
  })

  it('scope_switches counts scope_changed events (4 by 2 Humans)', () => {
    expect(row('scope_switches')).toMatchObject({
      value: 4,
      details: { switches: 4, distinctHumans: 2 },
    })
  })

  it('is idempotent: recomputing rewrites the same rows in place and picks up new data', async () => {
    const before = await metricMap(db, D)
    const again = await compute(D)
    expect(again.metrics).toHaveLength(EXPECTED_ROWS)
    const after = await metricMap(db, D)
    expect(after.size).toBe(before.size)
    for (const [key, previous] of before) {
      const current = after.get(key)
      expect(current?.value, key).toBe(previous.value)
      expect(current?.details, key).toEqual(previous.details)
      expect(Date.parse(current?.computed_at ?? '')).toBeGreaterThanOrEqual(
        Date.parse(previous.computed_at),
      )
    }
    expect(await count(db, 'public.metrics_daily', 'day = $1', [D])).toBe(EXPECTED_ROWS)
    // New facts change the value under the same key.
    await eventAt(
      hostA,
      'scope_changed',
      { from: 'friends', to: 'world', surface: 'home' },
      at(0, '17:00'),
    )
    await compute(D)
    expect((await metricMap(db, D)).get(metricKey('scope_switches'))).toMatchObject({
      value: 5,
      details: { switches: 5, distinctHumans: 3 },
    })
    // Other days are untouched and a day with nothing yields null ratios and zero counts.
    await compute(dayOffset(-40))
    const empty = await metricMap(db, dayOffset(-40))
    expect(empty.get(metricKey('group_seed_rate'))?.value).toBeNull()
    expect(empty.get(metricKey('rooms_started'))?.value).toBe(0)
    expect(await count(db, 'public.metrics_daily', 'day = $1', [D])).toBe(EXPECTED_ROWS)
  })

  it('is service only and validates the day', async () => {
    for (const as of ['visitor', hostA.as, (await createGuest(db)).as] as const) {
      let failure: unknown
      try {
        await db.rpc('metrics_compute_daily', { day: D }, as)
      } catch (error) {
        failure = error
      }
      expect(sqlstate(failure)).toBe(PERMISSION_DENIED)
    }
    // Even with an execute grant the role check inside refuses non-service callers.
    await db.sql.query(
      'grant execute on function public.metrics_compute_daily(date) to authenticated',
    )
    await db.expectError(db.rpc('metrics_compute_daily', { day: D }, hostA.as), 'forbidden')
    await db.sql.query(
      'revoke execute on function public.metrics_compute_daily(date) from authenticated',
    )
    await db.expectError(compute(null), 'invalid_input')
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    await db.expectError(compute(tomorrow), 'invalid_input')
  })

  it('rooms.max_visibility is the widest visibility ever applied and never lowered', async () => {
    const r1Row = await roomRow(db, r1)
    expect(r1Row.visibility).toBe('group')
    expect(await scalar(db, 'max_visibility::text from public.rooms where id = $1', [r1])).toBe(
      'friends',
    )
    // Direct attempts to lower it (service) are corrected by the trigger.
    await db.sql.query(`update public.rooms set max_visibility = 'invited' where id = $1`, [r1])
    expect(await scalar(db, 'max_visibility::text from public.rooms where id = $1', [r1])).toBe(
      'friends',
    )
    await db.sql.query(`update public.rooms set visibility = 'city' where id = $1`, [r1])
    expect(await scalar(db, 'max_visibility::text from public.rooms where id = $1', [r1])).toBe(
      'city',
    )
    // An insert below its own visibility is corrected too.
    const { rows } = await db.sql.query<{ max: string }>(
      `insert into public.rooms (context_type, initiated_by_human_id, visibility, join_policy, max_visibility)
       values ('standalone', $1, 'friends', 'friends', 'invited') returning max_visibility::text as max`,
      [hostA.humanId],
    )
    expect(rows[0]?.max).toBe('friends')
  })
})
