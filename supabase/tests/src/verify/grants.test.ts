/**
 * Adversarial verification of the "grants" invariant cluster (ARCHITECTURE §5, §15; DB_API
 * conventions; spec §114 launch blockers, §128 "Audience permission is server-authoritative"):
 *
 *   - Every table has RLS enabled and explicit, policy-backed grants; `earth` and `private` carry no
 *     privilege for anon/authenticated at any level (schema, table, sequence, function); `private`
 *     is closed to the service role as well.
 *   - Hashes are never readable: the hash / secret / token columns are inventoried and none is
 *     granted to a client role except two reviewed own-row values the caller supplied itself; the
 *     owner views drop them; no read RPC or view echoes a token or its sha256 once the creating RPC
 *     has returned the plaintext once.
 *   - Every function has an explicit execute ACL and nothing is executable by PUBLIC; every
 *     security definer function pins its search_path; no `earth.*` function that writes is
 *     executable by a client role even though the schema's default privileges grant EXECUTE to every
 *     new function (0002) — the allowlist of volatile earth functions a client may execute is exact.
 *   - anon EXECUTE breadth: every anon-executable mutating RPC outside the documented visitor
 *     surface fails closed for a visitor with `not_authenticated`, for Guests / unclaimed / claiming
 *     credentials with an auth-gate code, with the same code whether the arguments name real objects
 *     or random ones (no existence oracle), and without writing a single row — the rate-limit window
 *     included. `pg_stat_user_tables` counts rolled-back inserts too, so a write that happens before
 *     the caller gate is visible even though the failing transaction rolls it back.
 *   - The visitor-permitted mutating RPC (`analytics_track`) is rate-limited with the reduced budget,
 *     keyed by the client address.
 *   - Enum parity with @earth/domain beyond the `public` enum types: `earth.notification_type` and
 *     every text check constraint that mirrors a domain tuple; the inventory of enum-like check
 *     constraints is exact so a new one must be classified.
 *
 * Structural facts are introspected from the catalogs and fail on unknown objects; behavioural facts
 * are concrete RPC sequences as specific callers.
 */
import {
  CLAIM_INTENTS,
  EARTH_ERROR_CODES,
  ENUM_REGISTRY,
  GROUP_INVITE_STATUSES,
  GROUP_STATUSES,
  HUMAN_PASS_RISK_LEVELS,
  MEDIA_TYPES,
  MUTE_STATES,
  NOTIFICATION_LEVELS,
  NOTIFICATION_OBJECT_TYPES,
  NOTIFICATION_TYPES,
  PLACE_VISIBILITIES,
  PUSH_PLATFORMS,
  REPORT_TARGET_TYPES,
  ROLE_KINDS,
} from '@earth/domain'
import { createHash, randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { claimsFor, createTestDb, roleFor, type RoleSpec, type TestDb } from '../harness'
import { createInvite } from '../admission/fixtures'
import { EVENT_NAMES, TRACK_BATCH_MAX, TRACK_BUDGET, event, track } from '../analytics/fixtures'
import { createMedia, createPlace, createPost } from '../posts/fixtures'
import {
  addMember,
  befriend,
  createGroup,
  createGuest,
  createGuestSession,
  createHuman,
  createRoomInvite,
  createUnclaimed,
  directConversation,
  joinRoom,
  participantId,
  relate,
  scalar,
  startGroupRoom,
  startStandaloneRoom,
  type Guest,
  type Human,
} from '../rooms/fixtures'
import { errorCode, resetAllRateLimits } from '../safety/fixtures'

const CLIENT_ROLES = ['anon', 'authenticated'] as const
const PUBLIC_ROLE = 'public'
const APP_SCHEMAS = ['public', 'earth', 'private'] as const
const ERROR_CODES: ReadonlySet<string> = new Set<string>(EARTH_ERROR_CODES)
/** Codes an auth gate raises before any business logic (0160 earth.assert_*). */
const AUTH_GATE_CODES: ReadonlySet<string> = new Set([
  'not_authenticated',
  'not_a_human',
  'guest_not_allowed',
  'forbidden',
])
/** Human statuses that keep the credential a `human` for earth.current_role_kind() but fail earth.assert_human(). */
const NON_ACTIVE_STATUSES = ['restricted', 'suspended'] as const
/** Credential reads a Guest may complete (DB_API `guest` / `any auth`); every other credential read refuses a Guest. */
const GUEST_READS = ['guest_session_get', 'handle_available'] as const
/** Client addresses the visitor rate-limit probes are keyed by (`cf-connecting-ip`, 0004). */
const VISITOR_IP = '203.0.113.77'
const OTHER_VISITOR_IP = '203.0.113.78'

// ---------------------------------------------------------------------------------------------
// The anon-executable `public` RPC inventory, classified by who may do useful work with it.
// The union of the lists below must equal the introspected set (fails on an unclassified RPC).
// ---------------------------------------------------------------------------------------------

/** Volatile RPCs a visitor may call successfully (DB_API `any` / visitor rows). Rate-limited reads. */
const VISITOR_MUTATING_SURFACE = [
  'analytics_track',
  'areas_search',
  'group_invite_preview',
  'places_search',
  'room_invite_preview',
  'search',
] as const
/** Any credential (Guest, claiming, Human) may call; visitors get `not_authenticated` (DB_API `any auth`). */
const AUTH_ONLY = ['area_resolve'] as const
/** The claim flow: visitors `not_authenticated`, Guests `guest_not_allowed`; a real credential may write. */
const CLAIM_FLOW = [
  'claim_complete',
  'claim_set_identity',
  'claim_start',
  'claim_verification_begin',
  'identity_review_create',
] as const
/** Guests may call with a seat; visitors `not_authenticated`; unclaimed / claiming credentials `not_a_human`. */
const GUEST_CAPABLE = [
  'guest_session_create',
  'report_create',
  'room_join',
  'room_leave',
  'room_media_grant',
  'room_set_media_state',
  'rtc_diagnostic_record',
] as const
/** Granted to the API roles for PostgREST discovery only; the body refuses every non-service caller. */
const SERVICE_BY_CHECK = ['human_pass_record_result'] as const
/** Everything else that mutates: active Humans only. */
const HUMAN_ONLY = [
  'block_set',
  'context_resolve_and_set',
  'context_set',
  'conversation_direct_get_or_create',
  'conversation_group_create',
  'conversation_mark_read',
  'conversation_set_prefs',
  'follow_set',
  'friend_remove',
  'friend_request_accept',
  'friend_request_decline',
  'friend_request_send',
  'group_create',
  'group_invite_create',
  'group_invite_join',
  'group_invite_revoke',
  'group_leave',
  'group_member_remove',
  'group_member_set_role',
  'group_update',
  'human_delete_request',
  'identity_update',
  'location_share_create',
  'location_share_revoke',
  'location_share_update',
  'message_delete',
  'message_edit',
  'message_reaction_toggle',
  'message_send',
  'notification_mark_read',
  'notifications_mark_all_read',
  'place_create',
  'post_create',
  'post_delete',
  'post_hide',
  'post_reaction_set',
  'presence_ping',
  'push_token_register',
  'push_token_remove',
  'room_admit',
  'room_consent',
  'room_end',
  'room_invite_create',
  'room_invite_join',
  'room_remove_participant',
  'room_set_guests_disabled',
  'room_set_join_policy',
  'room_set_visibility',
  'room_start',
  'scope_set',
] as const

/** Read RPCs (stable) a visitor may call; visibility is decided inside. */
const VISITOR_READ_SURFACE = [
  'area_get',
  'feed_candidates',
  'live_candidates',
  'map_objects',
  'me_get',
  'place_get',
  'post_get',
  'post_replies',
  'posts_by_author',
  'profile_get',
  'public_feed',
  'room_get',
] as const
/** Read RPCs that need a credential: visitors get `not_authenticated` whatever the arguments. */
const CREDENTIAL_READS = [
  'blocks_list',
  'claim_get',
  'conversation_get',
  'conversation_read_receipts',
  'conversations_list',
  'group_get',
  'guest_session_get',
  'handle_available',
  'location_shares_mine',
  'location_shares_visible',
  'messages_list',
  'messages_since',
  'notifications_list',
  'notifications_unread_count',
  'reports_mine',
] as const

// ---------------------------------------------------------------------------------------------
// Structural expectations pinned to what 0002–0951 ship. A change here is a reviewed decision.
// ---------------------------------------------------------------------------------------------

/** Column-level grants (grantee=privileges, grantor stripped). Every other grant is table-level. */
const EXPECTED_COLUMN_ACLS = [
  'public.conversation_members.last_read_at authenticated=w',
  'public.conversation_members.last_read_message_id authenticated=w',
  'public.conversation_members.mute_state authenticated=w',
  'public.conversation_members.notification_level authenticated=w',
  'public.public_identities.avatar_media_id authenticated=w',
  'public.public_identities.bio authenticated=w',
  'public.public_identities.display_name authenticated=w',
  'public.public_identities.home_city_area_id authenticated=w',
  'public.public_identities.profile_visibility authenticated=w',
  'public.public_identities.public_city_visibility authenticated=w',
] as const

/** Every column whose name says hash / secret / token in the application schemas. */
const SECRET_COLUMNS = [
  'public.group_invites.token_hash',
  'public.guest_sessions.device_fingerprint_hash',
  'public.guest_sessions.session_secret_hash',
  'public.humans.claim_invite_token_hash',
  'public.push_tokens.token',
  'public.room_blocked_fingerprints.fingerprint_hash',
  'public.room_invites.token_hash',
] as const

/**
 * The only secret-named columns a client role may SELECT, each behind an own-row policy and holding
 * a value the caller supplied itself: a pending Human's hash of the group invite token they typed
 * (0120 humans_select_own; the hash cannot be reversed or replayed — joining needs the plaintext) and
 * a Human's own push token (0170 push_tokens_own; the device registered it).
 */
const SECRET_COLUMN_EXCEPTIONS = [
  'authenticated public.humans.claim_invite_token_hash',
  'authenticated public.push_tokens.token',
] as const

/** Owner views: they bypass RLS (no security_invoker), so each filters by the caller and drops hashes. */
const OWNER_VIEWS = ['group_invites_view', 'guest_sessions_view', 'room_invites_view'] as const

/**
 * Volatile, directly callable `earth.*` functions a client role may execute. Schema `earth` grants
 * EXECUTE on new functions by default (0002) so policies can call helpers; every writer must revoke
 * it explicitly. `earth.raise` only raises and `earth.random_token` only draws random bytes.
 */
const EARTH_VOLATILE_CLIENT_ALLOWLIST = [
  'earth.raise(code text, detail text)',
  'earth.random_token()',
] as const

/** `pg_default_acl` (schema objtype grantee=privileges), the whole privilege baseline of 0002. */
const EXPECTED_DEFAULT_ACLS = [
  '<global> f postgres=X',
  'earth f anon=X',
  'earth f authenticated=X',
  'earth f service_role=X',
  'extensions f anon=X',
  'extensions f authenticated=X',
  'extensions f service_role=X',
  'public S service_role=rwU',
  'public f service_role=X',
  'public r service_role=arwdDxt',
] as const

/** Text check constraints of the form `col in (...)` that mirror a domain tuple (order-free). */
const MIRRORED_CHECKS: Readonly<Record<string, readonly string[]>> = {
  'conversation_members.mute_state': MUTE_STATES,
  'conversation_members.notification_level': NOTIFICATION_LEVELS,
  'group_invites.status': GROUP_INVITE_STATUSES,
  'groups.status': GROUP_STATUSES,
  'human_passes.risk_level': HUMAN_PASS_RISK_LEVELS,
  'human_presence.platform': PUSH_PLATFORMS,
  'humans.claim_intent': CLAIM_INTENTS,
  'notifications.object_type': NOTIFICATION_OBJECT_TYPES,
  'places.visibility': PLACE_VISIBILITIES,
  'post_media.media_type': MEDIA_TYPES,
  'push_tokens.platform': PUSH_PLATFORMS,
  'reports.target_type': REPORT_TARGET_TYPES,
}
/** Enum-like text checks with no domain tuple yet (documented in DB_API / ARCHITECTURE prose only). */
const UNMIRRORED_CHECKS = [
  'auth_identities.provider',
  'human_passes.provider',
  'identity_reviews.kind',
  'identity_reviews.status',
  'media_objects.bucket',
  'posts.status',
  'reports.reporter_kind',
  'reports.severity',
  'room_invites.status',
] as const

const TRACK_EVENT_NAME = 'feed_opened'

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

interface FunctionRow {
  schema: string
  name: string
  identity: string
  secdef: boolean
  volatile: boolean
  returns_trigger: boolean
  anon: boolean
  authenticated: boolean
  service_role: boolean
  pub: boolean
  config: string[] | null
}

async function functions(db: TestDb): Promise<FunctionRow[]> {
  const { rows } = await db.sql.query<FunctionRow>(
    `select n.nspname as schema, p.proname as name,
            n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as identity,
            p.prosecdef as secdef, p.provolatile = 'v' as volatile,
            p.prorettype = 'trigger'::regtype as returns_trigger,
            has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
            has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
            has_function_privilege('public', p.oid, 'EXECUTE') as pub,
            p.proconfig as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = any($1::text[]) and p.prokind = 'f'
      order by 1, 2`,
    [[...APP_SCHEMAS]],
  )
  return rows
}

interface TableRow {
  schema: string
  name: string
  rls: boolean
  anon: string[]
  authenticated: string[]
  service_role: string[]
  pub: string[]
}

async function tables(db: TestDb): Promise<TableRow[]> {
  const { rows } = await db.sql.query<TableRow>(
    `with t as (
       select n.nspname as schema, c.relname as name, c.oid, c.relrowsecurity as rls
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p') and n.nspname = any($1::text[])
     ),
     privs as (
       select t.oid, r.role,
              coalesce(array_agg(p.cmd order by p.cmd) filter (where case
                when p.cmd = 'DELETE' then has_table_privilege(r.role, t.oid, p.cmd)
                else has_any_column_privilege(r.role, t.oid, p.cmd) end), '{}') as cmds
         from t
        cross join unnest(array['anon', 'authenticated', 'service_role', 'public']) as r(role)
        cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) as p(cmd)
        group by t.oid, r.role
     )
     select t.schema, t.name, t.rls,
            (select cmds from privs where privs.oid = t.oid and role = 'anon') as anon,
            (select cmds from privs where privs.oid = t.oid and role = 'authenticated') as authenticated,
            (select cmds from privs where privs.oid = t.oid and role = 'service_role') as service_role,
            (select cmds from privs where privs.oid = t.oid and role = 'public') as pub
       from t order by 1, 2`,
    [[...APP_SCHEMAS]],
  )
  return rows
}

interface PolicyRow {
  schema: string
  table: string
  name: string
  roles: string[]
  cmd: string
}

async function policies(db: TestDb): Promise<PolicyRow[]> {
  const { rows } = await db.sql.query<PolicyRow>(
    `select schemaname as schema, tablename as table, policyname as name, roles::text[] as roles, cmd
       from pg_policies where schemaname = any($1::text[]) order by 1, 2, 3`,
    [[...APP_SCHEMAS]],
  )
  return rows
}

/** Sum of inserted + updated + deleted tuples per user table, as the statistics collector counts them. */
async function tupleWrites(db: TestDb): Promise<Map<string, number>> {
  const { rows } = await db.sql.query<{ rel: string; n: string }>(
    `select schemaname || '.' || relname as rel, (n_tup_ins + n_tup_upd + n_tup_del)::text as n from pg_stat_user_tables`,
  )
  return new Map(rows.map((r) => [r.rel, Number(r.n)]))
}

function writesBetween(before: Map<string, number>, after: Map<string, number>): string[] {
  const changed: string[] = []
  for (const [rel, n] of after) {
    const delta = n - (before.get(rel) ?? 0)
    if (delta !== 0) changed.push(`${rel}+${delta}`)
  }
  return changed.sort()
}

interface Outcome {
  /** The P0001 machine code (or the SQL error message), null when the call succeeded. */
  code: string | null
  sqlstate: string | null
  /** Tables whose tuple counters moved during the call, rolled back or not. */
  writes: string[]
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Waits until every backend has flushed its pending table statistics (an idle backend flushes
 * within PGSTAT_MIN_INTERVAL = 1 s), so a probe's delta contains only the probe's own writes.
 */
async function settleStats(db: TestDb): Promise<Map<string, number>> {
  await db.sql.query('select pg_stat_force_next_flush()')
  let previous = await tupleWrites(db)
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(1100)
    const current = await tupleWrites(db)
    if (writesBetween(previous, current).length === 0) return current
    previous = current
  }
  throw new Error('table statistics did not settle')
}

/**
 * Calls the RPC as the caller on the harness's single superuser connection (`set local role` +
 * the caller's JWT claims, exactly like asRole) and reports the machine code plus every table
 * written during the call. The transaction is always rolled back — the matrix must never change the
 * world — and `pg_stat_force_next_flush()` runs in the same backend first, so the tuple counters
 * (which count rolled-back inserts, updates and deletes too) reach shared memory when the
 * transaction ends and the next statement reads them.
 */
async function probe(
  db: TestDb,
  name: string,
  args: Record<string, unknown>,
  as: RoleSpec,
  headers?: Record<string, string>,
): Promise<Outcome> {
  const keys = Object.keys(args)
  const placeholders = keys.map((key, i) => `"${key}" => $${i + 1}`).join(', ')
  const before = await tupleWrites(db)
  let code: string | null = null
  let sqlstate: string | null = null
  await db.sql.query('begin')
  try {
    await db.sql.query(`set local role ${roleFor(as)}`)
    await db.sql.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(claimsFor(as)),
    ])
    if (headers !== undefined) {
      await db.sql.query(`select set_config('request.headers', $1, true)`, [
        JSON.stringify(headers),
      ])
    }
    await db.sql.query('select pg_stat_force_next_flush()')
    await db.sql.query(
      `select * from public."${name}"(${placeholders})`,
      keys.map((key) => args[key]),
    )
  } catch (error) {
    if (!(error instanceof pg.DatabaseError)) throw error
    code = error.message
    sqlstate = error.code ?? null
  } finally {
    await db.sql.query('rollback')
  }
  const after = await tupleWrites(db)
  return { code, sqlstate, writes: writesBetween(before, after) }
}

function describeOutcome(caller: string, name: string, variant: string, outcome: Outcome): string {
  return `${caller} ${name}(${variant}) → ${outcome.code ?? 'succeeded'} [${outcome.sqlstate ?? '-'}] writes=[${outcome.writes.join(', ')}]`
}

// ---------------------------------------------------------------------------------------------
// The world every behavioural test probes against
// ---------------------------------------------------------------------------------------------

interface World {
  alice: Human
  bob: Human
  /** An active Human with no edge to Alice (a friend request to Carol is a real write). */
  carol: Human
  /** Sent Alice a friend request that is still pending (accept / decline are real writes). */
  dave: Human
  /** Bob's seat in Alice's standalone room (admit / remove target a seat that is not the caller's). */
  bobParticipantId: string
  /** Alice's live group room: `room_start(group)` by a member is a join, not a creation. */
  groupRoomId: string
  /** A pending Human with identity set and a verified Human Pass: `claim_complete` would succeed. */
  claimantReady: { userId: string; as: RoleSpec }
  claimingUserId: string
  restricted: Human
  suspended: Human
  groupId: string
  groupConversationId: string
  groupInviteId: string
  groupInviteToken: string
  roomId: string
  aliceParticipantId: string
  roomInviteToken: string
  guestSeated: Guest
  guestSessionSecret: string
  guestNoSeat: Guest
  unclaimed: RoleSpec
  claiming: RoleSpec
  postId: string
  dmId: string
  messageId: string
  mediaId: string
  areaId: string
  placeId: string
  shareId: string
  notificationId: string
}

async function buildWorld(db: TestDb): Promise<World> {
  const alice = await createHuman(db, { handle: 'grantsalice', displayName: 'Alice' })
  const bob = await createHuman(db, { handle: 'grantsbob', displayName: 'Bob' })
  const carol = await createHuman(db, { handle: 'grantscarol', displayName: 'Carol' })
  const dave = await createHuman(db, { handle: 'grantsdave', displayName: 'Dave' })
  const restricted = await createHuman(db, {
    handle: 'grantsrestricted',
    displayName: 'Restricted',
    status: 'restricted',
  })
  const suspended = await createHuman(db, {
    handle: 'grantssuspended',
    displayName: 'Suspended',
    status: 'suspended',
  })
  await befriend(db, alice, bob)
  await relate(db, dave, alice, 'friend_pending')

  const group = await createGroup(db, alice, 'Grants Crew')
  await addMember(db, group, bob)
  const groupInvite = await createInvite(db, group, alice)
  const groupRoom = await startGroupRoom(db, alice, group)

  const started = await startStandaloneRoom(db, alice, 'Grants room')
  const roomId = started.room.id
  const roomInvite = await createRoomInvite(db, roomId, alice)
  const bobSeat = await joinRoom(db, roomId, bob, 'watching')

  const guestSeated = await createGuest(db)
  const session = await createGuestSession(db, guestSeated, roomInvite.token, 'Sam')
  const guestNoSeat = await createGuest(db)

  const unclaimed = await createUnclaimed(db)
  const claimant = await createUnclaimed(db)
  await db.rpc(
    'claim_start',
    { intent: 'join_group', group_label: null, invite_token: groupInvite.token },
    claimant.as,
  )
  // A claimant one step from done: identity set, Human Pass verified by the service.
  const ready = await createUnclaimed(db)
  await db.rpc(
    'claim_start',
    { intent: 'start_group', group_label: 'Ready crew', invite_token: null },
    ready.as,
  )
  await db.rpc(
    'claim_set_identity',
    { display_name: 'Ready', handle: 'grantsready', avatar_media_id: null },
    ready.as,
  )
  const readyHumanId = await scalar<string>(
    db,
    'select id from public.humans where auth_user_id = $1',
    [ready.userId],
  )
  await db.rpc(
    'human_pass_record_result',
    {
      human_id: readyHumanId,
      status: 'verified',
      risk_level: 'low',
      provider: 'mock',
      provider_reference: null,
      metadata: {},
      duplicate_of_human_id: null,
    },
    'service',
  )

  const post = await createPost(db, alice, { text: 'grants world post', audience: 'world' })
  const dmId = await directConversation(db, alice, bob)
  const message = await db.rpc<{ id: string }>(
    'message_send',
    { conversation_id: dmId, client_id: randomUUID(), type: 'text', text: 'hello bob' },
    alice.as,
  )
  const mediaId = await createMedia(db, alice)
  const areaId = await scalar<string>(
    db,
    `select id from public.areas where type = 'city' order by name limit 1`,
  )
  const placeId = await createPlace(db, areaId, 'Grants Park')
  const share = await db.rpc<{ id: string }>(
    'location_share_create',
    {
      audience_type: 'friend',
      audience_id: bob.humanId,
      precision: 'precise',
      duration_seconds: 3600,
      lat: 37.8,
      lng: -122.41,
    },
    alice.as,
  )
  const { rows: notification } = await db.sql.query<{ id: string }>(
    `insert into public.notifications (recipient_human_id, type, actor_human_id, object_type, object_id, priority)
     values ($1, 'follow', $2, 'human', $2, 'low') returning id`,
    [alice.humanId, bob.humanId],
  )
  const notificationId = notification[0]?.id
  if (notificationId === undefined) throw new Error('notifications insert returned no id')

  return {
    alice,
    bob,
    carol,
    dave,
    bobParticipantId: participantId(bobSeat, bob.humanId),
    groupRoomId: groupRoom.room.id,
    claimantReady: ready,
    claimingUserId: claimant.userId,
    restricted,
    suspended,
    groupId: group.groupId,
    groupConversationId: group.conversationId,
    groupInviteId: groupInvite.inviteId,
    groupInviteToken: groupInvite.token,
    roomId,
    aliceParticipantId: participantId(started.room, alice.humanId),
    roomInviteToken: roomInvite.token,
    guestSeated,
    guestSessionSecret: session.sessionSecret,
    guestNoSeat,
    unclaimed: unclaimed.as,
    claiming: claimant.as,
    postId: post.post.id,
    dmId,
    messageId: message.id,
    mediaId,
    areaId,
    placeId,
    shareId: share.id,
    notificationId,
  }
}

/**
 * Arguments for every anon-executable RPC. `real` names objects that exist (Alice's group, room,
 * invite tokens, post, message, ...); otherwise the ids and tokens are random. A caller the gate
 * refuses must produce the same code for both.
 */
function argsFor(name: string, w: World, real: boolean): Record<string, unknown> {
  const id = (value: string): string => (real ? value : randomUUID())
  const token = (value: string): string => (real ? value : randomUUID().replace(/-/g, ''))
  const human = id(w.bob.humanId)
  const group = id(w.groupId)
  const room = id(w.roomId)
  const conversation = id(w.dmId)
  const message = id(w.messageId)
  const post = id(w.postId)
  switch (name) {
    // visitor surface
    case 'analytics_track':
      return { events: JSON.stringify([event(TRACK_EVENT_NAME)]) }
    case 'areas_search':
      return { q: 'San' }
    case 'places_search':
      return { q: 'Grants', area_id: null }
    case 'search':
      return { q: 'grants', limit: 10 }
    case 'group_invite_preview':
      return { token: token(w.groupInviteToken) }
    case 'room_invite_preview':
      return { token: token(w.roomInviteToken) }
    // any credential
    case 'area_resolve':
      return { lat: 37.77, lng: -122.42 }
    // claim flow
    case 'claim_start':
      return { intent: 'start_group', group_label: 'Crew', invite_token: null }
    case 'claim_set_identity':
      return { display_name: 'Probe', handle: 'grantsprobe', avatar_media_id: null }
    case 'claim_verification_begin':
      return { provider: 'mock' }
    case 'claim_complete':
      return {}
    case 'identity_review_create':
      return { kind: 'help', details: {} }
    // guest capable
    case 'guest_session_create':
      return {
        token: token(w.roomInviteToken),
        display_name: 'Sam',
        device_fingerprint_hash: null,
        media_state: 'audio',
      }
    case 'report_create':
      return { target_type: 'human', target_id: human, reason: 'harassment', details: null }
    case 'room_join':
      return { room_id: room, media_state: 'watching', consent_level: 'invited' }
    case 'room_leave':
    case 'room_media_grant':
      return { room_id: room }
    case 'room_set_media_state':
      return { room_id: room, media_state: 'audio', consent_level: null }
    case 'rtc_diagnostic_record':
      return { kind: 'ice_failed', room_id: room, payload: {} }
    // service by check
    case 'human_pass_record_result':
      return {
        human_id: id(w.alice.humanId),
        status: 'verified',
        risk_level: null,
        provider: null,
        provider_reference: null,
        metadata: {},
        duplicate_of_human_id: null,
      }
    // human only
    case 'block_set':
      return { target_human_id: human, blocked: true }
    case 'follow_set':
      return { target_human_id: human, following: true }
    case 'friend_request_send':
      return { target_human_id: human }
    case 'friend_remove':
      return { other_human_id: human }
    case 'friend_request_accept':
    case 'friend_request_decline':
      return { source_human_id: human }
    case 'context_resolve_and_set':
      return { lat: 37.77, lng: -122.42 }
    case 'context_set':
      return { current_area_id: id(w.areaId), current_city_id: null, home_city_id: null }
    case 'conversation_direct_get_or_create':
      return { other_human_id: human }
    case 'conversation_group_create':
      return { human_ids: [human, id(w.alice.humanId)] }
    case 'conversation_mark_read':
      return { conversation_id: conversation, message_id: null }
    case 'conversation_set_prefs':
      return { conversation_id: conversation, mute_state: 'muted', notification_level: null }
    case 'group_create':
      return { name: 'Probe crew' }
    case 'group_invite_create':
      return { group_id: group, expires_in_seconds: null, max_uses: null }
    case 'group_invite_join':
      return { token: token(w.groupInviteToken) }
    case 'group_invite_revoke':
      return { invite_id: id(w.groupInviteId) }
    case 'group_leave':
      return { group_id: group }
    case 'group_member_remove':
      return { group_id: group, human_id: human }
    case 'group_member_set_role':
      return { group_id: group, human_id: human, role: 'moderator' }
    case 'group_update':
      return { group_id: group, name: 'Renamed', avatar_media_id: null }
    case 'identity_update':
      return {
        display_name: 'Probe',
        bio: null,
        avatar_media_id: null,
        profile_visibility: null,
        public_city_visibility: null,
        home_city_area_id: null,
        handle: null,
      }
    case 'human_delete_request':
      return {}
    case 'location_share_create':
      return {
        audience_type: 'friend',
        audience_id: human,
        precision: 'precise',
        duration_seconds: 3600,
        lat: 37.8,
        lng: -122.41,
      }
    case 'location_share_revoke':
      return { share_id: id(w.shareId) }
    case 'location_share_update':
      return { share_id: id(w.shareId), lat: 37.81, lng: -122.4 }
    case 'message_delete':
      return { message_id: message }
    case 'message_edit':
      return { message_id: message, text: 'edited' }
    case 'message_reaction_toggle':
      return { message_id: message, reaction: '❤️' }
    case 'message_send':
      return {
        conversation_id: conversation,
        client_id: randomUUID(),
        type: 'text',
        text: 'probe',
        payload: {},
        reply_to_message_id: null,
      }
    case 'notification_mark_read':
      return { id: id(w.notificationId) }
    case 'notifications_mark_all_read':
      return {}
    case 'place_create':
      return { name: 'Probe Place', lat: 37.77, lng: -122.42, area_id: null, category: null }
    case 'post_create':
      return {
        type: 'text',
        text: 'probe',
        audience: 'friends',
        area_id: null,
        place_id: null,
        media: [],
        reply_policy: 'everyone_eligible',
        reshare_policy: 'allowed_within_audience',
        parent_post_id: null,
        provenance: null,
      }
    case 'post_delete':
    case 'post_hide':
      return { post_id: post }
    case 'post_reaction_set':
      return { post_id: post, reaction_type: 'heart' }
    case 'presence_ping':
      return { conversation_id: null, room_id: null, platform: 'web' }
    case 'push_token_register':
      return { token: 'probe-push-token', platform: 'ios' }
    case 'push_token_remove':
      return { token: 'probe-push-token' }
    case 'room_admit':
      return { room_id: room, participant_id: id(w.aliceParticipantId) }
    case 'room_consent':
      return { room_id: room, level: 'friends' }
    case 'room_end':
      return { room_id: room, reason: null }
    case 'room_invite_create':
      return { room_id: room, expires_in_seconds: null, join_policy_override: null }
    case 'room_invite_join':
      return { token: token(w.roomInviteToken), media_state: 'watching', consent_level: 'invited' }
    case 'room_remove_participant':
      return { room_id: room, participant_id: id(w.aliceParticipantId), block_from_room: false }
    case 'room_set_guests_disabled':
      return { room_id: room, disabled: true }
    case 'room_set_join_policy':
      return { room_id: room, join_policy: 'friends' }
    case 'room_set_visibility':
      return { room_id: room, visibility: 'friends', join_policy: null }
    case 'room_start':
      return { context_type: 'standalone', context_id: null, title: null }
    case 'scope_set':
      return { surface: 'home', scope: 'world' }
    // credential reads
    case 'blocks_list':
    case 'claim_get':
    case 'guest_session_get':
    case 'location_shares_mine':
    case 'location_shares_visible':
    case 'notifications_unread_count':
    case 'reports_mine':
      return {}
    case 'conversation_get':
    case 'conversation_read_receipts':
      return { conversation_id: conversation }
    case 'conversations_list':
      return { cursor: null, limit: 30 }
    case 'group_get':
      return { group_id: group }
    case 'handle_available':
      return { handle: real ? w.alice.handle : 'grantsnobody' }
    case 'messages_list':
      return { conversation_id: conversation, before_id: null, limit: 50 }
    case 'messages_since':
      return { conversation_id: conversation, after_id: null }
    case 'notifications_list':
      return { cursor: null, limit: 30 }
    // visitor reads
    case 'area_get':
      return { id: id(w.areaId) }
    case 'feed_candidates':
      return { scope: 'world', area_id: null, snapshot_at: null, limit: 20 }
    case 'live_candidates':
      return { scope: 'world', area_id: null, limit: 20 }
    case 'map_objects':
      return { scope: 'world', min_lat: 37.7, min_lng: -122.5, max_lat: 37.8, max_lng: -122.3 }
    case 'me_get':
      return {}
    case 'place_get':
      return { id: id(w.placeId) }
    case 'post_get':
      return { post_id: post }
    case 'post_replies':
      return { post_id: post, cursor: null, limit: 20 }
    case 'posts_by_author':
      return { handle: real ? w.alice.handle : 'grantsnobody', cursor: null, limit: 20 }
    case 'profile_get':
      return { handle: real ? w.alice.handle : 'grantsnobody' }
    case 'public_feed':
      return { cursor: null, limit: 20 }
    case 'room_get':
      return { room_id: room }
    default:
      throw new Error(`argsFor: no arguments defined for public.${name}`)
  }
}

/**
 * Arguments with which the RPC does real work for a legitimate caller (the `real` arguments of
 * `argsFor` are valid for Alice except where they would be a no-op or name Alice herself).
 */
function legitArgsFor(name: string, w: World, caller: 'human' | 'guest'): Record<string, unknown> {
  switch (name) {
    case 'friend_request_send':
      return { target_human_id: w.carol.humanId }
    case 'friend_request_accept':
    case 'friend_request_decline':
      return { source_human_id: w.dave.humanId }
    case 'conversation_group_create':
      return { human_ids: [w.bob.humanId, w.carol.humanId] }
    case 'room_admit':
    case 'room_remove_participant':
      return { ...argsFor(name, w, true), participant_id: w.bobParticipantId }
    case 'report_create':
      // A Guest may report only their room and its participants.
      return caller === 'guest'
        ? { target_type: 'room', target_id: w.roomId, reason: 'harassment', details: null }
        : argsFor(name, w, true)
    default:
      return argsFor(name, w, true)
  }
}

interface LegitCase {
  name: string
  caller: string
  as: RoleSpec
  /** The rate-limit subject (`earth.rate_limit_for_caller`): auth user id, or the client address for a visitor. */
  subject: string
  args: Record<string, unknown>
  headers?: Record<string, string>
}

/** Every mutating anon-executable RPC × every caller path that may legitimately use it. */
function legitCases(w: World): LegitCase[] {
  const asAlice = (name: string): LegitCase => ({
    name,
    caller: 'alice',
    as: w.alice.as,
    subject: w.alice.userId,
    args: legitArgsFor(name, w, 'human'),
  })
  const asSeatedGuest = (name: string): LegitCase => ({
    name,
    caller: 'guest(seated)',
    as: w.guestSeated.as,
    subject: w.guestSeated.userId,
    args: legitArgsFor(name, w, 'guest'),
  })
  const asNoSeatGuest = (name: string): LegitCase => ({
    name,
    caller: 'guest',
    as: w.guestNoSeat.as,
    subject: w.guestNoSeat.userId,
    args: argsFor(name, w, true),
  })
  const asClaiming = (name: string): LegitCase => ({
    name,
    caller: 'claiming',
    as: w.claiming,
    subject: w.claimingUserId,
    args: argsFor(name, w, true),
  })
  const asVisitor = (name: string): LegitCase => ({
    name,
    caller: 'visitor',
    as: 'visitor',
    subject: VISITOR_IP,
    args: argsFor(name, w, true),
    headers: { 'cf-connecting-ip': VISITOR_IP },
  })
  const guestCapableHuman = GUEST_CAPABLE.filter((name) => name !== 'guest_session_create')
  return [
    ...HUMAN_ONLY.map(asAlice),
    ...guestCapableHuman.map(asAlice),
    ...guestCapableHuman.map(asSeatedGuest),
    asNoSeatGuest('guest_session_create'),
    ...CLAIM_FLOW.filter((name) => name !== 'claim_complete').map(asClaiming),
    {
      name: 'claim_complete',
      caller: 'claiming(ready)',
      as: w.claimantReady.as,
      subject: w.claimantReady.userId,
      args: {},
    },
    ...AUTH_ONLY.map(asNoSeatGuest),
    ...VISITOR_MUTATING_SURFACE.map(asVisitor),
  ]
}

interface RateLimitLiteral {
  action: string
  max: number
  window: number
}

/** Every `earth.rate_limit_for_caller('<action>', <max>, <window>)` literal in the public and earth sources. */
async function rateLimitInventory(db: TestDb): Promise<RateLimitLiteral[]> {
  const { rows } = await db.sql.query<{ action: string; max: string; window: string }>(
    `select distinct m[1] as action, m[2] as max, m[3] as window
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace,
            regexp_matches(p.prosrc, 'rate_limit_for_caller\\(\\s*''([a-z_]+)''\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\)', 'g') m
      where n.nspname in ('public', 'earth')
      order by 1, 2, 3`,
  )
  return rows.map((r) => ({ action: r.action, max: Number(r.max), window: Number(r.window) }))
}

/**
 * Fills every inventory window of `subject` to its Human budget (the largest literal per action,
 * which is above the reduced Guest / Visitor budget too), so the next attempt on any action is one
 * too many.
 */
async function exhaustWindows(
  db: TestDb,
  subject: string,
  inventory: readonly RateLimitLiteral[],
): Promise<void> {
  const byAction = new Map<string, { max: number; window: number }>()
  for (const { action, max, window } of inventory) {
    const current = byAction.get(action)
    byAction.set(action, {
      max: Math.max(current?.max ?? 0, max),
      window: Math.max(current?.window ?? 0, window),
    })
  }
  for (const [action, { max, window }] of byAction) {
    await db.sql.query(
      `insert into private.rate_limits (key, window_start, expires_at, count)
       values ($1, now(), now() + make_interval(secs => $2), $3)
       on conflict (key) do update set window_start = excluded.window_start, expires_at = excluded.expires_at, count = excluded.count`,
      [`${action}:${subject}`, window, max],
    )
  }
}

async function clearWindows(db: TestDb, subject: string): Promise<void> {
  await db.sql.query(
    `delete from private.rate_limits where substr(key, position(':' in key) + 1) = $1`,
    [subject],
  )
}

const rateLimitWrites = (outcome: Outcome): string[] =>
  outcome.writes.filter((w) => w.startsWith('private.rate_limits+'))
const otherWrites = (outcome: Outcome): string[] =>
  outcome.writes.filter((w) => !w.startsWith('private.rate_limits+'))

// ---------------------------------------------------------------------------------------------

describe('grants invariants — adversarial verification', () => {
  let db: TestDb
  let world: World
  let fns: FunctionRow[]

  beforeAll(async () => {
    db = await createTestDb()
    world = await buildWorld(db)
    fns = await functions(db)
    await resetAllRateLimits(db)
  })

  afterAll(async () => {
    await db.drop()
  })

  const publicVolatileAnon = (): string[] =>
    fns
      .filter((f) => f.schema === 'public' && f.volatile && f.anon)
      .map((f) => f.name)
      .sort()
  const publicStableAnon = (): string[] =>
    fns
      .filter((f) => f.schema === 'public' && !f.volatile && f.anon)
      .map((f) => f.name)
      .sort()

  // -------------------------------------------------------------------------------------------
  describe('the anon-executable RPC inventory is fully classified', () => {
    it('every anon-executable volatile public RPC is in exactly one behavioural class', () => {
      const classified = [
        ...VISITOR_MUTATING_SURFACE,
        ...AUTH_ONLY,
        ...CLAIM_FLOW,
        ...GUEST_CAPABLE,
        ...SERVICE_BY_CHECK,
        ...HUMAN_ONLY,
      ]
      expect(new Set(classified).size, 'a function is listed twice').toBe(classified.length)
      expect(publicVolatileAnon()).toEqual([...classified].sort())
    })

    it('every anon-executable stable public RPC is either visitor-readable or a credential read', () => {
      const classified = [...VISITOR_READ_SURFACE, ...CREDENTIAL_READS]
      expect(new Set(classified).size).toBe(classified.length)
      expect(publicStableAnon()).toEqual([...classified].sort())
    })

    it('argsFor knows every anon-executable RPC (so the matrix cannot silently skip one)', () => {
      for (const name of [...publicVolatileAnon(), ...publicStableAnon()]) {
        expect(() => argsFor(name, world, true), name).not.toThrow()
        expect(() => argsFor(name, world, false), name).not.toThrow()
      }
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('anon EXECUTE breadth: mutating RPCs fail closed before touching data', () => {
    interface FailsClosedOptions {
      /** RPCs probed with random arguments only (the real ones would legitimately succeed). */
      skipReal?: ReadonlySet<string>
      /** Tables the caller may legitimately write before being refused (default: none at all). */
      allowedWrites?: ReadonlySet<string>
      /** Require the same code for real and random arguments (default: yes — no existence oracle). */
      sameCode?: boolean
    }

    /**
     * Runs the RPC with real and with random arguments as the caller and collects a violation
     * unless: both calls fail with a P0001 machine code accepted by `codeOk`, the two codes are
     * identical (no existence oracle) and neither call wrote a single tuple (rolled back or not).
     */
    async function failsClosed(
      caller: string,
      as: RoleSpec,
      names: readonly string[],
      codeOk: (code: string, name: string) => boolean,
      options: FailsClosedOptions = {},
    ): Promise<string[]> {
      const skipReal = options.skipReal ?? new Set<string>()
      const allowedWrites = options.allowedWrites ?? new Set<string>()
      const violations: string[] = []
      await settleStats(db)
      for (const name of names) {
        const outcomes: Array<[string, Outcome]> = []
        if (!skipReal.has(name))
          outcomes.push(['real', await probe(db, name, argsFor(name, world, true), as)])
        outcomes.push(['random', await probe(db, name, argsFor(name, world, false), as)])
        for (const [variant, outcome] of outcomes) {
          const bad =
            outcome.code === null ||
            outcome.sqlstate !== 'P0001' ||
            !ERROR_CODES.has(outcome.code) ||
            !codeOk(outcome.code, name) ||
            outcome.writes.some((w) => !allowedWrites.has(w.replace(/\+\d+$/, '')))
          if (bad) violations.push(describeOutcome(caller, name, variant, outcome))
        }
        const codes = new Set(outcomes.map(([, o]) => o.code))
        if (options.sameCode !== false && codes.size > 1) {
          violations.push(
            `${caller} ${name}: code depends on whether the object exists (${[...codes].join(' vs ')})`,
          )
        }
      }
      return violations
    }

    it('a visitor gets not_authenticated from every non-visitor RPC, whatever the arguments, with zero writes', async () => {
      const violations = [
        ...(await failsClosed(
          'visitor',
          'visitor',
          [...HUMAN_ONLY, ...GUEST_CAPABLE, ...CLAIM_FLOW, ...AUTH_ONLY],
          (code) => code === 'not_authenticated',
        )),
        ...(await failsClosed(
          'visitor',
          'visitor',
          SERVICE_BY_CHECK,
          (code) => code === 'forbidden',
        )),
      ]
      expect(violations).toEqual([])
    })

    it('a Guest without a seat is stopped by an auth gate on every Human-only RPC and never writes anywhere', async () => {
      const guest = world.guestNoSeat.as
      const violations = [
        ...(await failsClosed(
          'guest',
          guest,
          HUMAN_ONLY,
          (code) => code === 'not_a_human' || code === 'guest_not_allowed',
        )),
        ...(await failsClosed('guest', guest, CLAIM_FLOW, (code) => code === 'guest_not_allowed')),
        ...(await failsClosed('guest', guest, SERVICE_BY_CHECK, (code) => code === 'forbidden')),
        // Guest-capable RPCs refuse a Guest with no seat with a machine code (the real invite token
        // would legitimately create a seat, so guest_session_create is probed with a random one). A
        // Guest is a credential, so these RPCs may spend its own rate-limit window before looking at
        // the seat — the only row they may touch — and their code may name the seat (`not_in_room`)
        // or the room (`room_not_found`).
        ...(await failsClosed(
          'guest',
          guest,
          GUEST_CAPABLE,
          (code) => !AUTH_GATE_CODES.has(code) || code === 'guest_not_allowed',
          {
            skipReal: new Set(['guest_session_create']),
            allowedWrites: new Set(['private.rate_limits']),
            sameCode: false,
          },
        )),
      ]
      expect(violations).toEqual([])
    })

    it('a real credential without a Human (unclaimed) gets not_a_human / forbidden, with zero writes', async () => {
      const violations = [
        ...(await failsClosed(
          'unclaimed',
          world.unclaimed,
          HUMAN_ONLY,
          (code) => code === 'not_a_human',
        )),
        ...(await failsClosed(
          'unclaimed',
          world.unclaimed,
          GUEST_CAPABLE,
          (code, name) => code === (name === 'guest_session_create' ? 'forbidden' : 'not_a_human'),
        )),
        ...(await failsClosed(
          'unclaimed',
          world.unclaimed,
          SERVICE_BY_CHECK,
          (code) => code === 'forbidden',
        )),
      ]
      expect(violations).toEqual([])
    })

    it('a claiming (pending) Human gets not_a_human / forbidden from every member RPC, with zero writes', async () => {
      const violations = [
        ...(await failsClosed(
          'claiming',
          world.claiming,
          HUMAN_ONLY,
          (code) => code === 'not_a_human',
        )),
        ...(await failsClosed(
          'claiming',
          world.claiming,
          GUEST_CAPABLE,
          (code, name) => code === (name === 'guest_session_create' ? 'forbidden' : 'not_a_human'),
        )),
        ...(await failsClosed(
          'claiming',
          world.claiming,
          SERVICE_BY_CHECK,
          (code) => code === 'forbidden',
        )),
      ]
      expect(violations).toEqual([])
    })

    it('a Guest with a seat is still not a Human: the gate refuses every Human-only and claim RPC with zero writes', async () => {
      const guest = world.guestSeated.as
      const violations = [
        ...(await failsClosed(
          'guest(seated)',
          guest,
          HUMAN_ONLY,
          (code) => code === 'not_a_human' || code === 'guest_not_allowed',
        )),
        ...(await failsClosed(
          'guest(seated)',
          guest,
          CLAIM_FLOW,
          (code) => code === 'guest_not_allowed',
        )),
        ...(await failsClosed(
          'guest(seated)',
          guest,
          SERVICE_BY_CHECK,
          (code) => code === 'forbidden',
        )),
      ]
      // Credential reads: the Guest surface works, every Human read refuses at the gate whatever the arguments.
      for (const name of CREDENTIAL_READS) {
        for (const real of [true, false]) {
          const code = await errorCode(db.rpc(name, argsFor(name, world, real), guest))
          const allowed = (GUEST_READS as readonly string[]).includes(name)
          if (allowed ? code !== null : !(code === 'not_a_human' || code === 'guest_not_allowed')) {
            violations.push(
              `guest(seated) ${name}(${real ? 'real' : 'random'}) → ${code ?? 'succeeded'}`,
            )
          }
        }
      }
      expect(violations).toEqual([])
      // The seat itself is real: the Guest's own room RPCs answer (the grant is used, not just tolerated).
      const me = await db.rpc<{ myParticipant: unknown }>(
        'room_get',
        { room_id: world.roomId },
        guest,
      )
      expect(me.myParticipant).not.toBeNull()
    })

    it('a restricted or suspended Human is refused by every member RPC with human_not_active and zero writes', async () => {
      const violations: string[] = []
      for (const status of NON_ACTIVE_STATUSES) {
        const as = world[status].as
        violations.push(
          ...(await failsClosed(status, as, HUMAN_ONLY, (code) => code === 'human_not_active')),
          ...(await failsClosed(
            status,
            as,
            GUEST_CAPABLE,
            (code, name) =>
              code === (name === 'guest_session_create' ? 'forbidden' : 'human_not_active'),
          )),
          ...(await failsClosed(status, as, SERVICE_BY_CHECK, (code) => code === 'forbidden')),
        )
      }
      expect(violations).toEqual([])
    })

    it('a restricted or suspended Human has no own-row write path either', async () => {
      for (const status of NON_ACTIVE_STATUSES) {
        const human = world[status]
        const attempts: Array<[string, string]> = [
          [
            'human_presence',
            `insert into public.human_presence (human_id) values ('${human.humanId}')`,
          ],
          [
            'human_context',
            `insert into public.human_context (human_id) values ('${human.humanId}')`,
          ],
          [
            'push_tokens',
            `insert into public.push_tokens (human_id, token, platform) values ('${human.humanId}', 'probe', 'web')`,
          ],
        ]
        for (const [table, sql] of attempts) {
          await expect(
            db.asRole(human.as, (c) => c.query(sql), { rollback: true }),
            `${status} ${table}`,
          ).rejects.toMatchObject({ code: '42501' })
        }
        const updated = await db.asRole(
          human.as,
          async (c) =>
            (
              await c.query(
                `update public.public_identities set bio = 'x' where human_id = '${human.humanId}'`,
              )
            ).rowCount,
          { rollback: true },
        )
        expect(updated, `${status} public_identities`).toBe(0)
      }
    })

    it('the auth-gate codes are the only codes a refused caller ever sees on Human-only RPCs', () => {
      // A refused caller must never learn anything beyond "who are you": the set of codes the
      // matrix accepts is exactly the gate set.
      expect([...AUTH_GATE_CODES].sort()).toEqual([
        'forbidden',
        'guest_not_allowed',
        'not_a_human',
        'not_authenticated',
      ])
      for (const code of AUTH_GATE_CODES) expect(ERROR_CODES.has(code), code).toBe(true)
    })

    it('credential-only reads give a visitor not_authenticated whatever the arguments', async () => {
      const violations: string[] = []
      for (const name of CREDENTIAL_READS) {
        for (const real of [true, false]) {
          const code = await errorCode(db.rpc(name, argsFor(name, world, real), 'visitor'))
          if (code !== 'not_authenticated')
            violations.push(`visitor ${name}(${real ? 'real' : 'random'}) → ${code ?? 'succeeded'}`)
        }
      }
      expect(violations).toEqual([])
    })

    it('the visitor surface actually works for a visitor (the anon grant is used, not just tolerated)', async () => {
      await resetAllRateLimits(db)
      const search = await db.rpc<{ people: unknown[] }>(
        'search',
        argsFor('search', world, true),
        'visitor',
      )
      expect(Array.isArray(search.people)).toBe(true)
      const areas = await db.rpc<unknown[]>(
        'areas_search',
        argsFor('areas_search', world, true),
        'visitor',
      )
      expect(Array.isArray(areas)).toBe(true)
      const places = await db.rpc<unknown[]>(
        'places_search',
        argsFor('places_search', world, true),
        'visitor',
      )
      expect(Array.isArray(places)).toBe(true)
      const groupPreview = await db.rpc<{ groupName: string }>(
        'group_invite_preview',
        argsFor('group_invite_preview', world, true),
        'visitor',
      )
      expect(groupPreview.groupName).toBe('Grants Crew')
      const roomPreview = await db.rpc<{ roomId: string }>(
        'room_invite_preview',
        argsFor('room_invite_preview', world, true),
        'visitor',
      )
      expect(roomPreview.roomId).toBe(world.roomId)
      const me = await db.rpc<{ roleKind: string; humanId: string | null }>('me_get', {}, 'visitor')
      expect(me).toMatchObject({ roleKind: 'visitor', humanId: null })
      // A Guest may resolve areas (any credential); a visitor may not (asserted above).
      const resolved = await db.rpc<{ city: unknown }>(
        'area_resolve',
        argsFor('area_resolve', world, true),
        world.guestNoSeat.as,
      )
      expect(resolved).toHaveProperty('city')
    })

    it('the only visitor-permitted mutating RPC is rate-limited with the reduced budget, keyed by client address', async () => {
      await resetAllRateLimits(db)
      expect((EVENT_NAMES as readonly string[]).includes(TRACK_EVENT_NAME)).toBe(true)
      const batch = Array.from({ length: TRACK_BATCH_MAX }, () => event(TRACK_EVENT_NAME))
      const visitorBatches = Math.ceil(TRACK_BUDGET / 2) / TRACK_BATCH_MAX
      const humanBatches = TRACK_BUDGET / TRACK_BATCH_MAX
      const ipA = { 'cf-connecting-ip': '203.0.113.60' }
      const ipB = { 'cf-connecting-ip': '203.0.113.61' }
      for (let i = 0; i < visitorBatches; i += 1) {
        expect(
          await track(db, batch, 'visitor', { headers: ipA }),
          `visitor batch ${i + 1}`,
        ).toEqual({ accepted: TRACK_BATCH_MAX })
      }
      await db.expectError(track(db, batch, 'visitor', { headers: ipA }), 'rate_limited')
      // Another address is another window; the refused batch consumed nothing.
      expect(await track(db, batch, 'visitor', { headers: ipB })).toEqual({
        accepted: TRACK_BATCH_MAX,
      })
      await db.expectError(track(db, batch, 'visitor', { headers: ipA }), 'rate_limited')
      // Guests share the reduced budget, keyed by their anonymous credential.
      for (let i = 0; i < visitorBatches; i += 1) {
        expect(await track(db, batch, world.guestNoSeat.as), `guest batch ${i + 1}`).toEqual({
          accepted: TRACK_BATCH_MAX,
        })
      }
      await db.expectError(track(db, batch, world.guestNoSeat.as), 'rate_limited')
      // A Human gets the full budget.
      for (let i = 0; i < humanBatches; i += 1) {
        expect(await track(db, batch, world.bob.as), `human batch ${i + 1}`).toEqual({
          accepted: TRACK_BATCH_MAX,
        })
      }
      await db.expectError(track(db, batch, world.bob.as), 'rate_limited')
      await resetAllRateLimits(db)
    })

    it('service-only RPCs are denied to anon and authenticated by the grant itself, not by their body', async () => {
      const serviceOnly = fns
        .filter((f) => f.schema === 'public' && !f.anon)
        .map((f) => f.name)
        .sort()
      expect(serviceOnly).toEqual([
        'metrics_compute_daily',
        'notifications_mark_pushed',
        'notifications_prune',
        'notifications_unsent',
        'report_resolve',
        'room_participant_sync',
        'rooms_sweep',
      ])
      for (const f of fns.filter((f) => f.schema === 'public' && !f.anon)) {
        expect(f.authenticated, `${f.name} authenticated`).toBe(false)
        expect(f.service_role, `${f.name} service_role`).toBe(true)
      }
      await expect(db.rpc('rooms_sweep', {}, world.guestNoSeat.as)).rejects.toMatchObject({
        code: '42501',
      })
      await expect(db.rpc('rooms_sweep', {}, world.alice.as)).rejects.toMatchObject({
        code: '42501',
      })
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('hashes are never readable', () => {
    it('the secret-named columns are exactly the known ones and only the two own-row exceptions are client-readable', async () => {
      const { rows } = await db.sql.query<{ col: string }>(
        `select table_schema || '.' || table_name || '.' || column_name as col
           from information_schema.columns
          where table_schema = any($1::text[]) and column_name ~ '(hash|secret|token)'
          order by 1`,
        [[...APP_SCHEMAS]],
      )
      expect(rows.map((r) => r.col)).toEqual([...SECRET_COLUMNS])

      const readable: string[] = []
      for (const col of SECRET_COLUMNS) {
        const [schema, table, column] = col.split('.') as [string, string, string]
        for (const role of [...CLIENT_ROLES, PUBLIC_ROLE]) {
          const { rows: p } = await db.sql.query<{ ok: boolean }>(
            `select has_column_privilege($1, $2::regclass, $3, 'SELECT') as ok`,
            [role, `${schema}.${table}`, column],
          )
          if (p[0]?.ok) readable.push(`${role} ${col}`)
        }
      }
      expect(readable.sort()).toEqual([...SECRET_COLUMN_EXCEPTIONS])
    })

    it('the own-row exception really is own-row: a claiming Human sees only the hash of the token they typed', async () => {
      const rows = await db.asRole(
        world.claiming,
        async (c) =>
          (
            await c.query<{ h: string | null }>(
              'select claim_invite_token_hash as h from public.humans',
            )
          ).rows,
      )
      expect(rows).toEqual([{ h: sha256Hex(world.groupInviteToken) }])
      // Nobody else's row, and Alice (whose row carries no hash) sees only hers.
      const alice = await db.asRole(
        world.alice.as,
        async (c) =>
          (
            await c.query<{ h: string | null }>(
              'select claim_invite_token_hash as h from public.humans',
            )
          ).rows,
      )
      expect(alice).toEqual([{ h: null }])
      // The hash is not the token: it cannot join the group.
      expect(
        await errorCode(
          db.rpc('group_invite_join', { token: sha256Hex(world.groupInviteToken) }, world.bob.as),
        ),
      ).toBe('invite_invalid')
    })

    it('the base tables behind the owner views are ungranted and naming a hash column is denied', async () => {
      for (const [table, column, as] of [
        ['public.group_invites', 'token_hash', world.alice.as],
        ['public.room_invites', 'token_hash', world.alice.as],
        ['public.guest_sessions', 'session_secret_hash', world.guestSeated.as],
        ['public.guest_sessions', 'session_secret_hash', world.alice.as],
        ['public.room_blocked_fingerprints', 'fingerprint_hash', world.alice.as],
      ] as const) {
        await expect(
          db.asRole(as, (c) => c.query(`select ${column} from ${table}`)),
          `${table}.${column}`,
        ).rejects.toMatchObject({ code: '42501' })
      }
    })

    it('owner views exist exactly as listed, drop every hash column, filter by the caller and are closed to anon', async () => {
      const { rows } = await db.sql.query<{
        name: string
        columns: string[]
        options: string[] | null
        def: string
        anon: boolean
      }>(
        `select c.relname as name,
                (select array_agg(a.attname::text order by a.attnum) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as columns,
                c.reloptions as options,
                pg_get_viewdef(c.oid) as def,
                has_table_privilege('anon', c.oid, 'SELECT') as anon
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('v', 'm')
          order by 1`,
      )
      expect(rows.map((r) => r.name)).toEqual([...OWNER_VIEWS])
      for (const view of rows) {
        expect(
          view.columns.filter((c) => /(hash|secret|token)/.test(c)),
          `${view.name} columns`,
        ).toEqual([])
        // An owner view (no security_invoker) bypasses RLS: it must filter by the caller itself.
        expect(
          (view.options ?? []).some((o) => o.startsWith('security_invoker')),
          `${view.name} runs as owner`,
        ).toBe(false)
        expect(view.def, `${view.name} filters by the caller`).toMatch(
          /earth\.current_(human|role_kind)\(\)/,
        )
        expect(view.anon, `${view.name} anon`).toBe(false)
      }
    })

    it('no read RPC, view or DTO echoes a token or its hash after the creating RPC returned it once', async () => {
      const secrets = [
        world.groupInviteToken,
        world.roomInviteToken,
        world.guestSessionSecret,
        sha256Hex(world.groupInviteToken),
        sha256Hex(world.roomInviteToken),
        sha256Hex(world.guestSessionSecret),
      ]
      const outputs: Array<[string, unknown]> = [
        [
          'group_get(alice)',
          await db.rpc('group_get', { group_id: world.groupId }, world.alice.as),
        ],
        ['room_get(alice)', await db.rpc('room_get', { room_id: world.roomId }, world.alice.as)],
        [
          'room_get(guest)',
          await db.rpc('room_get', { room_id: world.roomId }, world.guestSeated.as),
        ],
        ['guest_session_get(guest)', await db.rpc('guest_session_get', {}, world.guestSeated.as)],
        ['me_get(claiming)', await db.rpc('me_get', {}, world.claiming)],
        ['claim_get(claiming)', await db.rpc('claim_get', {}, world.claiming)],
        [
          'conversations_list(alice)',
          await db.rpc('conversations_list', { cursor: null, limit: 30 }, world.alice.as),
        ],
        [
          'group_invite_preview(visitor)',
          await db.rpc('group_invite_preview', { token: world.groupInviteToken }, 'visitor'),
        ],
        [
          'room_invite_preview(visitor)',
          await db.rpc('room_invite_preview', { token: world.roomInviteToken }, 'visitor'),
        ],
        [
          'group_invites_view(alice)',
          await db.asRole(
            world.alice.as,
            async (c) =>
              (await c.query('select to_jsonb(v) as row from public.group_invites_view v')).rows,
          ),
        ],
        [
          'room_invites_view(alice)',
          await db.asRole(
            world.alice.as,
            async (c) =>
              (await c.query('select to_jsonb(v) as row from public.room_invites_view v')).rows,
          ),
        ],
        [
          'guest_sessions_view(alice)',
          await db.asRole(
            world.alice.as,
            async (c) =>
              (await c.query('select to_jsonb(v) as row from public.guest_sessions_view v')).rows,
          ),
        ],
        [
          'guest_sessions_view(guest)',
          await db.asRole(
            world.guestSeated.as,
            async (c) =>
              (await c.query('select to_jsonb(v) as row from public.guest_sessions_view v')).rows,
          ),
        ],
      ]
      // The views did return rows (the assertion below cannot pass by emptiness).
      expect(
        (outputs.find(([n]) => n === 'group_invites_view(alice)')?.[1] as unknown[]).length,
      ).toBe(1)
      expect(
        (outputs.find(([n]) => n === 'room_invites_view(alice)')?.[1] as unknown[]).length,
      ).toBe(1)
      expect(
        (outputs.find(([n]) => n === 'guest_sessions_view(guest)')?.[1] as unknown[]).length,
      ).toBe(1)
      const leaks: string[] = []
      for (const [label, output] of outputs) {
        const text = JSON.stringify(output)
        for (const secret of secrets)
          if (text.includes(secret)) leaks.push(`${label} contains ${secret.slice(0, 8)}…`)
      }
      expect(leaks).toEqual([])
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('every table: RLS enabled, explicit policy-backed grants, earth/private closed', () => {
    let tableRows: TableRow[]
    let policyRows: PolicyRow[]

    beforeAll(async () => {
      tableRows = await tables(db)
      policyRows = await policies(db)
    })

    it('has row level security enabled on every table of public, earth and private', () => {
      expect(tableRows.length).toBeGreaterThan(40)
      expect(tableRows.filter((t) => !t.rls).map((t) => `${t.schema}.${t.name}`)).toEqual([])
    })

    it('keeps earth free of tables and private closed to every API role and PUBLIC', () => {
      expect(tableRows.filter((t) => t.schema === 'earth')).toEqual([])
      const privateTables = tableRows.filter((t) => t.schema === 'private').map((t) => t.name)
      expect(privateTables).toEqual(['audit_log', 'human_pass_metadata', 'rate_limits'])
      for (const t of tableRows.filter((t) => t.schema === 'private')) {
        expect(
          {
            anon: t.anon,
            authenticated: t.authenticated,
            service_role: t.service_role,
            pub: t.pub,
          },
          t.name,
        ).toEqual({ anon: [], authenticated: [], service_role: [], pub: [] })
      }
    })

    it('grants PUBLIC nothing on any table', () => {
      expect(tableRows.filter((t) => t.pub.length > 0).map((t) => `${t.schema}.${t.name}`)).toEqual(
        [],
      )
    })

    it('backs every client grant with a policy for that role and command; no policy is granted to PUBLIC', () => {
      const gaps: string[] = []
      for (const p of policyRows) {
        const outside = p.roles.filter((r) => !(CLIENT_ROLES as readonly string[]).includes(r))
        if (outside.length > 0)
          gaps.push(`policy ${p.schema}.${p.table}.${p.name} names roles ${outside.join(',')}`)
      }
      for (const t of tableRows.filter((t) => t.schema === 'public')) {
        for (const role of CLIENT_ROLES) {
          for (const cmd of t[role]) {
            const covered = policyRows.some(
              (p) =>
                p.schema === t.schema &&
                p.table === t.name &&
                p.roles.includes(role) &&
                (p.cmd === cmd || p.cmd === 'ALL'),
            )
            if (!covered) gaps.push(`${t.schema}.${t.name}: ${role} has ${cmd} but no policy`)
          }
        }
      }
      expect(gaps).toEqual([])
    })

    it('column-level grants are exactly the reviewed own-row update columns', async () => {
      const { rows } = await db.sql.query<{ entry: string }>(
        `select n.nspname || '.' || c.relname || '.' || a.attname || ' ' || regexp_replace(acl::text, '/.*$', '') as entry
           from pg_attribute a
           join pg_class c on c.oid = a.attrelid
           join pg_namespace n on n.oid = c.relnamespace
           cross join unnest(a.attacl) as acl
          where a.attacl is not null and n.nspname = any($1::text[])
          order by 1`,
        [[...APP_SCHEMAS]],
      )
      expect(rows.map((r) => r.entry)).toEqual([...EXPECTED_COLUMN_ACLS])
    })

    it('no sequence is usable by anon, authenticated or PUBLIC', async () => {
      const { rows } = await db.sql.query<{ seq: string }>(
        `select n.nspname || '.' || c.relname as seq
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind = 'S' and n.nspname = any($1::text[])
            and (has_sequence_privilege('anon', c.oid, 'USAGE') or has_sequence_privilege('anon', c.oid, 'SELECT')
                 or has_sequence_privilege('authenticated', c.oid, 'USAGE') or has_sequence_privilege('authenticated', c.oid, 'SELECT')
                 or has_sequence_privilege('public', c.oid, 'USAGE') or has_sequence_privilege('public', c.oid, 'SELECT'))`,
        [[...APP_SCHEMAS]],
      )
      expect(rows).toEqual([])
    })

    it('schema privileges: clients may use public and extensions only; service_role never reaches private', async () => {
      const { rows } = await db.sql.query<{
        role: string
        schema: string
        usage: boolean
        create: boolean
      }>(
        `select r.role, s.schema, has_schema_privilege(r.role, s.schema, 'USAGE') as usage, has_schema_privilege(r.role, s.schema, 'CREATE') as create
           from unnest(array['anon', 'authenticated', 'service_role', 'public']) as r(role)
          cross join unnest(array['public', 'earth', 'private', 'extensions']) as s(schema)
          order by 1, 2`,
      )
      const usable = rows
        .filter((r) => r.usage)
        .map((r) => `${r.role} ${r.schema}`)
        .sort()
      // PUBLIC keeps USAGE on `public` (the Postgres / Supabase default; the roles Supabase itself
      // runs depend on it). Naming an object is not reaching it: every table, sequence and function
      // privilege of PUBLIC is revoked (asserted elsewhere in this file), so the schema lock that
      // matters is earth / private, where PUBLIC has nothing.
      expect(usable).toEqual([
        'anon extensions',
        'anon public',
        'authenticated extensions',
        'authenticated public',
        'public public',
        'service_role earth',
        'service_role extensions',
        'service_role public',
      ])
      expect(rows.filter((r) => r.create).map((r) => `${r.role} ${r.schema}`)).toEqual([])
    })

    it('the default privileges are exactly the 0002 baseline (nothing for anon/authenticated on new public objects)', async () => {
      const { rows } = await db.sql.query<{ entry: string }>(
        `select coalesce(n.nspname, '<global>') || ' ' || d.defaclobjtype::text || ' ' || regexp_replace(acl::text, '/.*$', '') as entry
           from pg_default_acl d
           left join pg_namespace n on n.oid = d.defaclnamespace
          cross join unnest(d.defaclacl) as acl
          order by 1`,
      )
      expect(rows.map((r) => r.entry)).toEqual([...EXPECTED_DEFAULT_ACLS])
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('every function: explicit execute grants, no PUBLIC, pinned search_path, no client-executable writer in earth', () => {
    it('nothing in public, earth or private is executable by PUBLIC', () => {
      expect(fns.filter((f) => f.pub).map((f) => f.identity)).toEqual([])
    })

    it('every public RPC is security definer and explicitly executable by service_role', () => {
      const publicFns = fns.filter((f) => f.schema === 'public')
      expect(publicFns.length).toBeGreaterThan(90)
      expect(publicFns.filter((f) => !f.secdef).map((f) => f.identity)).toEqual([])
      expect(publicFns.filter((f) => !f.service_role).map((f) => f.identity)).toEqual([])
      // anon and authenticated always agree: there is no RPC one client role may call and the other not.
      expect(publicFns.filter((f) => f.anon !== f.authenticated).map((f) => f.identity)).toEqual([])
    })

    it('every security definer function pins search_path to public, earth, private[, extensions], pg_temp', () => {
      const loose = fns
        .filter((f) => f.secdef)
        .filter((f) => {
          const setting = (f.config ?? []).find((c) => c.startsWith('search_path='))
          return (
            setting === undefined ||
            !/^search_path=public, earth, private(, extensions)?, pg_temp$/.test(setting)
          )
        })
        .map((f) => `${f.identity} ${JSON.stringify(f.config)}`)
      expect(loose).toEqual([])
    })

    it('no earth function that is security definer and volatile is executable by a client role', () => {
      const writers = fns.filter((f) => f.schema === 'earth' && f.secdef && f.volatile)
      expect(
        writers.length,
        'the rate-limit, notify, audit and *_internal helpers exist',
      ).toBeGreaterThan(10)
      expect(writers.filter((f) => f.anon || f.authenticated).map((f) => f.identity)).toEqual([])
    })

    it('the volatile earth functions a client role may execute are exactly the side-effect-free allowlist', () => {
      const callable = fns
        .filter(
          (f) =>
            f.schema === 'earth' && f.volatile && !f.returns_trigger && (f.anon || f.authenticated),
        )
        .map((f) => f.identity)
        .sort()
      expect(callable).toEqual([...EARTH_VOLATILE_CLIENT_ALLOWLIST])
    })

    it('private holds no function a client or the service could execute', () => {
      const priv = fns.filter((f) => f.schema === 'private')
      expect(
        priv.filter((f) => f.anon || f.authenticated || f.service_role).map((f) => f.identity),
      ).toEqual([])
    })

    it('a client role cannot name an earth helper even where it holds EXECUTE (schema USAGE is the second lock)', async () => {
      for (const as of ['visitor', world.alice.as, world.guestNoSeat.as] as const) {
        await expect(
          db.asRole(as, (c) => c.query('select earth.random_token()')),
        ).rejects.toMatchObject({ code: '42501' })
        await expect(
          db.asRole(as, (c) => c.query(`select earth.raise('forbidden')`)),
        ).rejects.toMatchObject({ code: '42501' })
      }
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('enum parity with @earth/domain beyond the public enum types', () => {
    it('earth.notification_type is the only enum outside public and equals NOTIFICATION_TYPES in order', async () => {
      const { rows } = await db.sql.query<{ name: string; values: string[] }>(
        `select n.nspname || '.' || t.typname as name, array_agg(e.enumlabel::text order by e.enumsortorder) as values
           from pg_type t join pg_namespace n on n.oid = t.typnamespace join pg_enum e on e.enumtypid = t.oid
          where t.typtype = 'e' and n.nspname <> 'public' and n.nspname not in ('pg_catalog', 'information_schema')
          group by 1 order by 1`,
      )
      expect(rows).toEqual([{ name: 'earth.notification_type', values: [...NOTIFICATION_TYPES] }])
    })

    it('every enum-like text check constraint is classified, and the mirrored ones equal their domain tuple', async () => {
      const { rows } = await db.sql.query<{ table: string; def: string }>(
        `select c.relname as table, pg_get_constraintdef(k.oid) as def
           from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
          where k.contype = 'c' and n.nspname = 'public' and pg_get_constraintdef(k.oid) ~ '= ANY \\('
          order by 1, 2`,
      )
      const found = new Map<string, string[]>()
      for (const row of rows) {
        const literal = /(\w+) = ANY \(ARRAY\[((?:'[^']*'::text(?:, )?)+)\]\)/.exec(row.def)
        if (literal !== null) {
          const [, column, list] = literal as unknown as [string, string, string]
          const values = [...list.matchAll(/'([^']*)'::text/g)].map((m) => m[1] as string)
          found.set(`${row.table}.${column}`, values.sort())
          continue
        }
        const viaFunction = /(\w+) = ANY \(earth\.report_target_types\(\)\)/.exec(row.def)
        if (viaFunction !== null) {
          const { rows: fn } = await db.sql.query<{ v: string[] }>(
            'select earth.report_target_types() as v',
          )
          found.set(`${row.table}.${viaFunction[1]}`, [...(fn[0]?.v ?? [])].sort())
        }
        // Constraints over enum-typed columns (`'x'::report_status`) are covered by enum-parity.test.ts.
      }
      const classified = [...Object.keys(MIRRORED_CHECKS), ...UNMIRRORED_CHECKS].sort()
      expect([...found.keys()].sort()).toEqual(classified)
      for (const [key, tuple] of Object.entries(MIRRORED_CHECKS)) {
        expect(found.get(key), key).toEqual([...tuple].sort())
      }
    })

    it('every enum literal cast in the function sources names a value of that enum, and earth.notify is only called with NOTIFICATION_TYPES', async () => {
      // `'label'::public.<enum>` / `'label'::<enum>` casts are only checked by Postgres when the branch
      // runs; a typo in a rarely taken branch would fail in production first.
      const { rows: casts } = await db.sql.query<{ fn: string; label: string; typ: string }>(
        `select n.nspname || '.' || p.proname as fn, m[1] as label, lower(m[2]) as typ
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace,
                regexp_matches(p.prosrc, '''([a-z_]+)''::(?:public\\.|earth\\.)?([a-z_]+)', 'g') m
          where n.nspname in ('public', 'earth')`,
      )
      const enumNames = new Set<string>([...Object.keys(ENUM_REGISTRY), 'notification_type'])
      const enumCasts = casts.filter((c) => enumNames.has(c.typ))
      expect(enumCasts.length).toBeGreaterThan(20)
      const invalid = enumCasts.filter((c) => {
        const labels: readonly string[] =
          c.typ === 'notification_type'
            ? NOTIFICATION_TYPES
            : ENUM_REGISTRY[c.typ as keyof typeof ENUM_REGISTRY]
        return !labels.includes(c.label)
      })
      expect(invalid.map((c) => `${c.fn}: '${c.label}'::${c.typ}`)).toEqual([])

      const { rows: notifies } = await db.sql.query<{ fn: string; type: string }>(
        `select n.nspname || '.' || p.proname as fn, m[1] as type
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace,
                regexp_matches(p.prosrc, 'earth\\.notify\\(\\s*[^,]+,\\s*''([a-z_]+)''', 'g') m
          where n.nspname in ('public', 'earth')`,
      )
      expect(notifies.length).toBeGreaterThan(3)
      expect(
        notifies.filter((n) => !(NOTIFICATION_TYPES as readonly string[]).includes(n.type)),
      ).toEqual([])

      // earth.current_role_kind() returns exactly the ROLE_KINDS the domain and the clients branch on.
      const { rows: kinds } = await db.sql.query<{ kind: string }>(
        `select distinct m[1] as kind
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace,
                regexp_matches(p.prosrc, 'return ''([a-z_]+)''', 'g') m
          where n.nspname = 'earth' and p.proname = 'current_role_kind'
          order by 1`,
      )
      expect(kinds.map((k) => k.kind).sort()).toEqual([...ROLE_KINDS].sort())
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('rate limits are live on every mutating RPC, for every caller path that may use it', () => {
    let inventory: RateLimitLiteral[]
    let cases: LegitCase[]

    beforeAll(async () => {
      inventory = await rateLimitInventory(db)
      cases = legitCases(world)
      expect(inventory.length).toBeGreaterThan(60)
    })

    it('the legitimate caller of every mutating RPC succeeds and spends a rate-limit window doing so', async () => {
      // The source-level review (safety/rate-limits.test.ts) proves the call is in the body; this
      // proves it runs on the success path of every caller kind — a limit inside a branch the caller
      // never takes would pass the review and protect nothing.
      await resetAllRateLimits(db)
      await settleStats(db)
      const violations: string[] = []
      for (const c of cases) {
        const outcome = await probe(db, c.name, c.args, c.as, c.headers)
        if (outcome.code !== null) {
          violations.push(
            `${c.caller} ${c.name} → ${outcome.code} [${outcome.sqlstate ?? '-'}] (the fixture call must succeed)`,
          )
        } else if (rateLimitWrites(outcome).length === 0) {
          violations.push(
            `${c.caller} ${c.name} succeeded without charging a rate-limit window (writes=[${outcome.writes.join(', ')}])`,
          )
        }
      }
      expect(violations).toEqual([])
    })

    it('with every window of the caller exhausted, each mutating RPC answers rate_limited before writing any other row', async () => {
      await resetAllRateLimits(db)
      const subjects = [...new Set(cases.map((c) => c.subject))]
      for (const subject of subjects) await exhaustWindows(db, subject, inventory)
      await settleStats(db)
      const violations: string[] = []
      for (const c of cases) {
        const outcome = await probe(db, c.name, c.args, c.as, c.headers)
        if (outcome.code !== 'rate_limited' || otherWrites(outcome).length > 0) {
          violations.push(describeOutcome(c.caller, c.name, 'legit', outcome))
        }
      }
      for (const subject of subjects) await clearWindows(db, subject)
      expect(violations).toEqual([])
    })

    it('room_start on a context whose room is already live is a join and spends the join window (0964)', async () => {
      // Bob is a member of the group whose room Alice keeps live: 0330 seated him through
      // earth.room_join_human and returned before any rate limit ran.
      await resetAllRateLimits(db)
      await exhaustWindows(db, world.bob.userId, inventory)
      await settleStats(db)
      const args = { context_type: 'group', context_id: world.groupId, title: null }
      const refused = await probe(db, 'room_start', args, world.bob.as)
      expect(describeOutcome('bob', 'room_start', 'existing room', refused)).toMatch(
        /→ rate_limited \[P0001\] writes=\[private\.rate_limits\+\d+\]$/,
      )
      await clearWindows(db, world.bob.userId)
      await settleStats(db)
      const joined = await probe(db, 'room_start', args, world.bob.as)
      expect(joined.code).toBeNull()
      expect(rateLimitWrites(joined).length, 'the join charged a window').toBe(1)
      expect(joined.writes.some((w) => w.startsWith('public.room_participants+'))).toBe(true)
      // Bob ends up seated in the group room, not creating a second one: the group's room is unchanged.
      const room = await db.rpc<{ room: { id: string }; created: boolean }>(
        'room_start',
        args,
        world.bob.as,
      )
      expect(room).toMatchObject({ created: false, room: { id: world.groupRoomId } })
      await db.rpc('room_leave', { room_id: world.groupRoomId }, world.bob.as)
      await resetAllRateLimits(db)
    })

    it("a visitor's exhausted window is keyed by the client address: another address keeps its budget", async () => {
      await resetAllRateLimits(db)
      await exhaustWindows(db, VISITOR_IP, inventory)
      await settleStats(db)
      for (const name of VISITOR_MUTATING_SURFACE) {
        const args = argsFor(name, world, true)
        const refused = await probe(db, name, args, 'visitor', { 'cf-connecting-ip': VISITOR_IP })
        expect(refused.code, `${name} from the exhausted address`).toBe('rate_limited')
        const fresh = await probe(db, name, args, 'visitor', {
          'cf-connecting-ip': OTHER_VISITOR_IP,
        })
        expect(fresh.code, `${name} from another address`).toBeNull()
      }
      await clearWindows(db, VISITOR_IP)
      await clearWindows(db, OTHER_VISITOR_IP)
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('policy-backed grants match the RPC rules (0962)', () => {
    it('a private Place is readable on the table by its creator only — as place_get, places_search and map_objects already said', async () => {
      const { rows } = await db.sql.query<{ id: string }>(
        `insert into public.places (name, area_id, location, visibility, created_by_human_id)
         values ('Grants hideout', $1, extensions.st_setsrid(extensions.st_makepoint(-122.41, 37.76), 4326), 'private', $2)
         returning id`,
        [world.areaId, world.alice.humanId],
      )
      const secret = rows[0]?.id
      if (secret === undefined) throw new Error('places insert returned no id')
      const readBy = async (as: RoleSpec): Promise<number> =>
        db.asRole(
          as,
          async (c) =>
            (
              await c.query(
                'select lat, lng, created_by_human_id from public.places where id = $1',
                [secret],
              )
            ).rowCount ?? 0,
        )
      // 0050 answered every one of these with the exact position and the creator.
      expect(await readBy('visitor'), 'visitor').toBe(0)
      expect(await readBy(world.bob.as), 'another Human').toBe(0)
      expect(await readBy(world.guestSeated.as), 'guest').toBe(0)
      expect(await readBy(world.claiming), 'claiming').toBe(0)
      expect(await readBy(world.alice.as), 'creator').toBe(1)
      // Public Places stay readable by everyone, and the RPC agrees with the table.
      const publicRead = await db.asRole(
        'visitor',
        async (c) =>
          (await c.query('select 1 from public.places where id = $1', [world.placeId])).rowCount ??
          0,
      )
      expect(publicRead).toBe(1)
      expect(await errorCode(db.rpc('place_get', { id: secret }, world.bob.as))).toBe('not_visible')
      expect(await errorCode(db.rpc('place_get', { id: secret }, 'visitor'))).toBe('not_visible')
      expect(
        await db.rpc<{ id: string }>('place_get', { id: secret }, world.alice.as),
      ).toMatchObject({ id: secret, visibility: 'private' })
      await db.sql.query('delete from public.places where id = $1', [secret])
    })

    it('no select policy on a client-readable table is an unconditional `true` unless the table carries no per-row rule', async () => {
      // areas, feature_flags and app_settings are read-all by contract (0006, 0050); everything else
      // that a client may select must decide per row.
      const { rows } = await db.sql.query<{ table: string }>(
        `select tablename as table from pg_policies
          where schemaname = 'public' and cmd = 'SELECT' and qual = 'true'
          order by 1`,
      )
      expect(rows.map((r) => r.table)).toEqual(['app_settings', 'areas', 'feature_flags'])
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('roles and ownership behind the grants', () => {
    it('the API roles carry no attribute beyond what PostgREST needs and are members of nothing', async () => {
      const { rows } = await db.sql.query<{
        rolname: string
        rolsuper: boolean
        rolinherit: boolean
        rolcreaterole: boolean
        rolcreatedb: boolean
        rolcanlogin: boolean
        rolreplication: boolean
        rolbypassrls: boolean
      }>(`select rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls
            from pg_roles where rolname in ('anon', 'authenticated', 'service_role') order by 1`)
      expect(rows.map((r) => r.rolname)).toEqual(['anon', 'authenticated', 'service_role'])
      for (const r of rows) {
        expect(
          {
            super: r.rolsuper,
            createrole: r.rolcreaterole,
            createdb: r.rolcreatedb,
            login: r.rolcanlogin,
            replication: r.rolreplication,
          },
          r.rolname,
        ).toEqual({
          super: false,
          createrole: false,
          createdb: false,
          login: false,
          replication: false,
        })
        // Only the service role bypasses RLS (Supabase's own definition); the client roles never do.
        expect(r.rolbypassrls, `${r.rolname} bypassrls`).toBe(r.rolname === 'service_role')
      }
      const { rows: memberships } = await db.sql.query<{ member: string; role: string }>(
        `select m.rolname as member, g.rolname as role
           from pg_auth_members am
           join pg_roles m on m.oid = am.member
           join pg_roles g on g.oid = am.roleid
          where m.rolname in ('anon', 'authenticated', 'service_role')`,
      )
      expect(memberships).toEqual([])
      // Nothing that can log in is a member of a client role or the service role except the
      // PostgREST connection role and the superusers that own the schema.
      const { rows: members } = await db.sql.query<{ member: string }>(
        `select distinct m.rolname as member
           from pg_auth_members am
           join pg_roles m on m.oid = am.member
           join pg_roles g on g.oid = am.roleid
          where g.rolname in ('anon', 'authenticated', 'service_role') and m.rolcanlogin and not m.rolsuper`,
      )
      expect(members.map((m) => m.member)).toEqual(['authenticator'])
    })

    it('every relation and function of the application schemas is owned by the migration role, never by an API role', async () => {
      const apiRoles = ['anon', 'authenticated', 'service_role', 'authenticator']
      const { rows: relations } = await db.sql.query<{ rel: string; owner: string }>(
        `select n.nspname || '.' || c.relname as rel, pg_get_userbyid(c.relowner) as owner
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = any($1::text[]) and c.relkind in ('r', 'p', 'v', 'm', 'S')`,
        [[...APP_SCHEMAS]],
      )
      expect(relations.length).toBeGreaterThan(40)
      expect(relations.filter((r) => apiRoles.includes(r.owner))).toEqual([])
      const { rows: procs } = await db.sql.query<{ fn: string; owner: string }>(
        `select n.nspname || '.' || p.proname as fn, pg_get_userbyid(p.proowner) as owner
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = any($1::text[])`,
        [[...APP_SCHEMAS]],
      )
      expect(procs.filter((p) => apiRoles.includes(p.owner))).toEqual([])
      // One owner for everything: a security definer RPC runs with exactly the privileges the
      // migration role has, never with those of a role a client could become.
      expect(new Set([...relations.map((r) => r.owner), ...procs.map((p) => p.owner)]).size).toBe(1)
    })
  })
})
