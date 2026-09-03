/**
 * Execute-privilege matrix over every RPC in schema `public` (ARCHITECTURE §5; DB_API conventions;
 * spec §114 — launch blocker).
 *
 * Every function is classified into one of two grant profiles and the introspected privileges must
 * match it exactly. The classification is the whole inventory of `public` functions, so the test
 * fails when an RPC is added or removed without updating it ("fail on unknown functions").
 *
 *   client  — `grant execute to anon, authenticated, service_role`. The RPC is reachable by any
 *             caller and gates itself at runtime with `earth.current_role_kind()` /
 *             `earth.assert_human()` (visitors get `not_authenticated`, guests/claiming `not_a_human`,
 *             etc.). anon EXECUTE is defence-in-depth, never authorization.
 *   service — `grant execute to service_role` only. The push dispatcher, the LiveKit webhook
 *             reconciler, the sweep, the metrics job and the moderation queue mover. anon and
 *             authenticated have no EXECUTE at all (42501 before any body runs).
 *
 * PUBLIC (the pseudo-role) never has EXECUTE on any `public` function: 0002 revokes the built-in
 * default and grants are role-explicit, so a future login role inherits nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type TestDb } from '../harness'

/** `grant execute to service_role` only — no anon/authenticated EXECUTE. */
const SERVICE_ONLY = [
  'metrics_compute_daily',
  'notifications_mark_pushed',
  'notifications_prune',
  'notifications_unsent',
  'report_resolve',
  'room_participant_sync',
  'rooms_sweep',
] as const

/** Every other `public` function: granted to anon, authenticated and service_role. */
const CLIENT_FUNCTIONS = [
  'analytics_track',
  'area_get',
  'area_resolve',
  'areas_search',
  'block_set',
  'blocks_list',
  'claim_complete',
  'claim_get',
  'claim_set_identity',
  'claim_start',
  'claim_verification_begin',
  'context_resolve_and_set',
  'context_set',
  'conversation_direct_get_or_create',
  'conversation_get',
  'conversation_group_create',
  'conversation_mark_read',
  'conversation_read_receipts',
  'conversation_set_prefs',
  'conversations_list',
  'feed_candidates',
  'follow_set',
  'friend_remove',
  'friend_request_accept',
  'friend_request_decline',
  'friend_request_send',
  'group_create',
  'group_get',
  'group_invite_create',
  'group_invite_join',
  'group_invite_preview',
  'group_invite_revoke',
  'group_leave',
  'group_member_remove',
  'group_member_set_role',
  'group_update',
  'guest_session_create',
  'guest_session_get',
  'handle_available',
  'human_delete_request',
  'human_pass_record_result',
  'identity_review_create',
  'identity_update',
  'live_candidates',
  'location_share_create',
  'location_share_revoke',
  'location_share_update',
  'location_shares_mine',
  'location_shares_visible',
  'map_objects',
  'me_get',
  'message_delete',
  'message_edit',
  'message_reaction_toggle',
  'message_send',
  'messages_list',
  'messages_since',
  'notification_mark_read',
  'notifications_list',
  'notifications_mark_all_read',
  'notifications_unread_count',
  'place_create',
  'place_get',
  'places_search',
  'post_create',
  'post_delete',
  'post_get',
  'post_hide',
  'post_reaction_set',
  'post_replies',
  'posts_by_author',
  'presence_ping',
  'profile_get',
  'public_feed',
  'push_token_register',
  'push_token_remove',
  'report_create',
  'reports_mine',
  'room_admit',
  'room_consent',
  'room_end',
  'room_get',
  'room_invite_create',
  'room_invite_join',
  'room_invite_preview',
  'room_join',
  'room_leave',
  'room_media_grant',
  'room_remove_participant',
  'room_set_guests_disabled',
  'room_set_join_policy',
  'room_set_media_state',
  'room_set_visibility',
  'room_start',
  'rtc_diagnostic_record',
  'scope_set',
  'search',
] as const

/**
 * The RPCs DB_API marks callable by `any` / `any auth` / `visitor` — the ones that do useful work
 * for a caller without an active Human. They are a subset of the `client` profile (all client RPCs
 * grant anon EXECUTE); this list is the contract's own "public surface" and every entry must be
 * anon-executable. `handle_available` is `any auth` (it raises `not_authenticated` for a visitor)
 * but is still anon-granted, so it belongs here as a grant-level fact.
 */
const CONTRACT_PUBLIC_SURFACE = [
  'analytics_track',
  'area_get',
  'area_resolve',
  'areas_search',
  'feed_candidates',
  'group_invite_preview',
  'handle_available',
  'live_candidates',
  'map_objects',
  'me_get',
  'place_get',
  'places_search',
  'posts_by_author',
  'profile_get',
  'public_feed',
  'room_get',
  'room_invite_preview',
  'search',
] as const

interface FunctionGrant {
  name: string
  identity: string
  anon: boolean
  authenticated: boolean
  service_role: boolean
  pub: boolean
  secdef: boolean
}

async function publicFunctions(db: TestDb): Promise<FunctionGrant[]> {
  const { rows } = await db.sql.query<FunctionGrant>(
    `select p.proname as name,
            pg_get_function_identity_arguments(p.oid) as identity,
            has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
            has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
            has_function_privilege('public', p.oid, 'EXECUTE') as pub,
            p.prosecdef as secdef
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f'
      order by p.proname`,
  )
  return rows
}

describe('execute-privilege matrix over public RPCs', () => {
  let db: TestDb
  let functions: FunctionGrant[]

  beforeAll(async () => {
    db = await createTestDb()
    functions = await publicFunctions(db)
  })

  afterAll(async () => {
    await db.drop()
  })

  it('the public function inventory is exactly the expected set (fails on any added/removed RPC)', () => {
    const introspected = functions.map((f) => f.name).sort()
    const expected = [...SERVICE_ONLY, ...CLIENT_FUNCTIONS].sort()
    // No accidental overloads: each name appears once in public.
    expect(new Set(introspected).size, 'no overloaded names in public').toBe(introspected.length)
    expect(introspected).toEqual(expected)
  })

  it('the two expectation lists are disjoint and self-consistent', () => {
    const service = new Set<string>(SERVICE_ONLY)
    const overlap = CLIENT_FUNCTIONS.filter((n) => service.has(n))
    expect(overlap, 'a function cannot be both client and service').toEqual([])
    expect(
      CONTRACT_PUBLIC_SURFACE.every((n) => (CLIENT_FUNCTIONS as readonly string[]).includes(n)),
    ).toBe(true)
  })

  describe('per-function grants', () => {
    const service = new Set<string>(SERVICE_ONLY)
    for (const name of [...SERVICE_ONLY, ...CLIENT_FUNCTIONS]) {
      it(`${name}`, () => {
        const fn = functions.find((f) => f.name === name)
        expect(fn, `${name} exists in public`).toBeDefined()
        if (fn === undefined) return
        // Every RPC is a security definer function (ARCHITECTURE §5).
        expect(fn.secdef, `${name} is security definer`).toBe(true)
        // PUBLIC never has EXECUTE.
        expect(fn.pub, `${name} not executable by PUBLIC`).toBe(false)
        if (service.has(name)) {
          expect(
            { anon: fn.anon, authenticated: fn.authenticated, service_role: fn.service_role },
            name,
          ).toEqual({
            anon: false,
            authenticated: false,
            service_role: true,
          })
        } else {
          expect(
            { anon: fn.anon, authenticated: fn.authenticated, service_role: fn.service_role },
            name,
          ).toEqual({
            anon: true,
            authenticated: true,
            service_role: true,
          })
        }
      })
    }
  })

  it('no function is executable by anon unless it is in the client (anon-granted) set', () => {
    const clientSet = new Set<string>(CLIENT_FUNCTIONS)
    const anonExecutable = functions.filter((f) => f.anon).map((f) => f.name)
    const unexpected = anonExecutable.filter((n) => !clientSet.has(n))
    expect(unexpected, 'anon-executable functions must all be client-profile RPCs').toEqual([])
  })

  it('the service-only RPCs deny anon and authenticated before any body runs', async () => {
    const guest = await db.createAuthUser({ isAnonymous: true })
    const cases: Array<[string, Record<string, unknown>]> = [
      ['metrics_compute_daily', { day: '2026-06-15' }],
      ['notifications_mark_pushed', { ids: [] }],
      ['notifications_prune', { days: 90 }],
      ['notifications_unsent', { limit: 10 }],
      ['report_resolve', { report_id: '00000000-0000-0000-0000-000000000000', status: 'resolved' }],
      [
        'room_participant_sync',
        {
          room_id: '00000000-0000-0000-0000-000000000000',
          livekit_identity: 'h:x',
          event: 'participant_left',
          at: null,
        },
      ],
      ['rooms_sweep', {}],
    ]
    for (const [name, args] of cases) {
      for (const as of ['visitor', { userId: guest, isAnonymous: true }] as const) {
        await expect(
          db.rpc(name, args, as),
          `${name} as ${typeof as === 'string' ? as : 'guest'}`,
        ).rejects.toMatchObject({
          code: '42501',
        })
      }
    }
  })

  it('the contract public surface is anon-executable at the grant level', async () => {
    for (const name of CONTRACT_PUBLIC_SURFACE) {
      const fn = functions.find((f) => f.name === name)
      expect(fn?.anon, `${name} anon-executable`).toBe(true)
    }
  })
})
