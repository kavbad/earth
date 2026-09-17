/**
 * API client ↔ SQL parity (ARCHITECTURE §7; DB_API.md).
 *
 * The typed client (`packages/api`) describes every call it makes in `RPC_MANIFEST` /
 * `CALLS` (`packages/api/src/manifest.ts`): the RPC name, the argument names it sends and the DTO
 * schema it parses the result with. This file holds the manifest against the database:
 *
 *   1. Signatures — for every RPC entry, `pg_proc` in schema `public` has the function, every
 *      argument the client sends is a parameter, every parameter without a default is sent, nothing
 *      unknown is sent, and the manifest lists the arguments in the function's parameter order.
 *      Every `public` RPC is either a client RPC or a documented server-tier RPC.
 *   2. Results — a representative world is built through the RPCs (three Humans through the claim
 *      flow, a group, a direct and a group conversation with messages, a room with a Guest, posts
 *      with media, notifications, shares, a report); every RPC the manifest names is called with
 *      realistic arguments and its result parsed with the very schema the client uses.
 *
 * The client is imported by relative path like `src/domain.ts` does for `@earth/domain`.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  AppSettingRowsSchema,
  FeatureFlagRowsSchema,
  GroupInviteRowsSchema,
  MediaObjectRowSchema,
} from '../../../../packages/api/src/dto'
import {
  type ArgNames,
  CALLS,
  type CallSpec,
  MANIFEST_RPC_NAMES,
  RPC_MANIFEST,
  type RpcSpec,
} from '../../../../packages/api/src/manifest'
import { SERVER_TIER_RPCS } from '../../../../packages/api/src/rpc'
import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import { BASE_AREA_SLUGS, POINTS } from '../geo/fixtures'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface PgFunction {
  name: string
  params: string[]
  required: string[]
  result: string
}

async function loadPublicFunctions(db: TestDb): Promise<Map<string, PgFunction[]>> {
  const { rows } = await db.sql.query<{
    name: string
    arg_names: string[] | null
    nargs: number
    ndefaults: number
    result: string
  }>(
    `select p.proname as name,
            p.proargnames[1:p.pronargs] as arg_names,
            p.pronargs as nargs,
            p.pronargdefaults as ndefaults,
            pg_get_function_result(p.oid) as result
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f'
      order by p.proname`,
  )
  const functions = new Map<string, PgFunction[]>()
  for (const row of rows) {
    const params = row.arg_names ?? []
    const required = params.slice(0, row.nargs - row.ndefaults)
    const overloads = functions.get(row.name) ?? []
    overloads.push({ name: row.name, params, required, result: row.result })
    functions.set(row.name, overloads)
  }
  return functions
}

const ALL_SPECS: CallSpec[] = Object.values(CALLS)
const RPC_SPECS: RpcSpec[] = ALL_SPECS.filter((spec): spec is RpcSpec => spec.kind === 'rpc')

interface Person {
  userId: string
  humanId: string
  handle: string
  as: RoleSpec
}

const SF_BBOX = { min_lat: 37.6, min_lng: -122.6, max_lat: 37.9, max_lng: -122.2 } as const

describe('API client ↔ SQL parity (RPC_MANIFEST vs pg_proc and live results)', () => {
  let db: TestDb
  let functions: Map<string, PgFunction[]>
  const exercised = new Set<string>()

  /** Calls the RPC of a manifest spec as `as` and parses the result with the spec's schema. */
  async function call<T>(
    spec: RpcSpec<ArgNames, T>,
    args: Record<string, unknown>,
    as: RoleSpec,
  ): Promise<T> {
    const unknownArgs = Object.keys(args).filter((key) => !spec.args.includes(key))
    if (unknownArgs.length > 0) {
      throw new Error(`${spec.method}: arguments not in the manifest: ${unknownArgs.join(', ')}`)
    }
    const raw = await db.rpc(spec.rpc, args, as)
    exercised.add(spec.rpc)
    if (spec.schema === null) return undefined as T
    const parsed = spec.schema.safeParse(raw)
    if (!parsed.success) {
      throw new Error(
        `${spec.method} → ${spec.rpc} does not satisfy ${spec.result}:\n` +
          `${JSON.stringify(parsed.error.issues, null, 2)}\nresult: ${JSON.stringify(raw)}`,
      )
    }
    return parsed.data
  }

  /** A JSON value as PostgREST would serialize the rows of `sql` (timestamps as ISO strings). */
  async function jsonRows(as: RoleSpec, sql: string, values: unknown[] = []): Promise<unknown> {
    return db.asRole(as, async (client) => {
      const { rows } = await client.query<{ rows: unknown }>(
        `select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) as rows from (${sql}) t`,
        values,
      )
      return rows[0]?.rows
    })
  }

  beforeAll(async () => {
    db = await createTestDb()
    functions = await loadPublicFunctions(db)
  })

  afterAll(async () => {
    await db.drop()
  })

  // -------------------------------------------------------------------------------------------
  describe('signatures: every manifest RPC matches its pg_proc entry', () => {
    it('the manifest names at least one RPC per namespace and no duplicates', () => {
      expect(RPC_SPECS.length).toBeGreaterThan(50)
      const methods = RPC_MANIFEST.map((entry) => entry.method)
      expect(new Set(methods).size).toBe(methods.length)
    })

    it.each(RPC_SPECS.map((spec) => ({ method: spec.method, rpc: spec.rpc, spec })))(
      '$method → public.$rpc(...) takes exactly the arguments the client sends',
      ({ spec }) => {
        const overloads = functions.get(spec.rpc)
        expect(overloads, `public.${spec.rpc} does not exist`).toBeDefined()
        expect(overloads, `public.${spec.rpc} is overloaded`).toHaveLength(1)
        const fn = (overloads as PgFunction[])[0] as PgFunction
        expect(fn.result, `public.${spec.rpc} must return jsonb (or boolean)`).toMatch(
          /^(jsonb|boolean)$/,
        )
        const sent = [...spec.args]
        // Every argument the client sends is a parameter (nothing unknown is sent).
        expect(sent.filter((arg) => !fn.params.includes(arg))).toEqual([])
        // Every parameter without a default is sent.
        expect(fn.required.filter((param) => !sent.includes(param))).toEqual([])
        // The manifest lists the arguments in the function's parameter order (README parity).
        expect(sent).toEqual(fn.params.filter((param) => sent.includes(param)))
      },
    )

    it('every public RPC has a client method or is a documented server-tier RPC', () => {
      const client = new Set(MANIFEST_RPC_NAMES)
      const server = new Set<string>(SERVER_TIER_RPCS)
      const unaccounted = [...functions.keys()].filter(
        (name) => !client.has(name) && !server.has(name),
      )
      expect(unaccounted).toEqual([])
      const missing = [...client, ...server].filter((name) => !functions.has(name))
      expect(missing).toEqual([])
      expect([...client].filter((name) => server.has(name))).toEqual([])
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('results: every manifest RPC answers what the client parses', () => {
    let xavier: Person
    let maya: Person
    let kavon: Person
    let guest: RoleSpec
    let groupId: string
    let groupConversationId: string
    let inviteToken: string
    let sfId: string
    let northBeachId: string
    let doloresParkId: string
    let dmId: string
    let messageId: string
    let mayaMessageId: string
    let roomId: string
    let roomToken: string
    let postId: string
    let replyId: string
    let shareId: string

    async function recordVerified(humanId: string): Promise<void> {
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

    /** The claim flow through the RPCs (spec §44–48): a real credential becomes an active Human. */
    async function claimHuman(spec: {
      handle: string
      displayName: string
      intent: 'start_group' | 'join_group'
      groupLabel?: string
      inviteToken?: string
    }): Promise<{ person: Person; groupId: string; conversationId: string }> {
      const userId = await db.createAuthUser({ email: `${spec.handle}@parity.test` })
      const as: RoleSpec = { userId }
      const started = await call(
        CALLS.claimStart,
        {
          intent: spec.intent,
          group_label: spec.groupLabel ?? null,
          invite_token: spec.inviteToken ?? null,
        },
        as,
      )
      expect(started.status).toBe('started')
      expect((await call(CALLS.meGet, {}, as)).roleKind).toBe('claiming')
      expect((await call(CALLS.claimGet, {}, as)).humanId).toBe(started.humanId)
      const withIdentity = await call(
        CALLS.claimSetIdentity,
        { display_name: spec.displayName, handle: spec.handle, avatar_media_id: null },
        as,
      )
      expect(withIdentity.identity?.handle).toBe(spec.handle)
      const begun = await call(CALLS.claimBeginVerification, { provider: 'mock' }, as)
      expect(begun.status).toBe('verifying')
      await recordVerified(started.humanId)
      const complete = await call(CALLS.claimComplete, {}, as)
      expect(complete.humanId).toBe(started.humanId)
      return {
        person: { userId, humanId: complete.humanId, handle: spec.handle, as },
        groupId: complete.groupId,
        conversationId: complete.conversationId,
      }
    }

    it('visitors: me_get and the public reads', async () => {
      const me = await call(CALLS.meGet, {}, 'visitor')
      expect(me).toMatchObject({ roleKind: 'visitor', humanId: null, identity: null })
      const flags = FeatureFlagRowsSchema.parse(
        await jsonRows(
          'visitor',
          `select ${CALLS.flagsGet.args.join(', ')} from public.feature_flags`,
        ),
      )
      expect(flags.map((row) => row.key)).toContain('GROUP_ANCHORED_CLAIM_REQUIRED')
      const settings = AppSettingRowsSchema.parse(
        await jsonRows(
          'visitor',
          `select ${CALLS.settingsGet.args.join(', ')} from public.app_settings`,
        ),
      )
      expect(settings.map((row) => row.key)).toContain('room_grace_seconds')
    })

    it('geography the world is built on (areas_search, area_get, area_resolve, places_search, place_get)', async () => {
      // Areas and places are readable by anyone; the base rows come from 0510.
      const areas = await call(CALLS.locationSearchAreas, { q: 'San Francisco' }, 'visitor')
      const sf = areas.find((area) => area.type === 'city' && area.name === 'San Francisco')
      expect(sf).toBeDefined()
      sfId = (sf as { id: string }).id
      expect((await call(CALLS.locationGetArea, { id: sfId }, 'visitor')).id).toBe(sfId)
      const { rows } = await db.sql.query<{ id: string }>(
        'select id from public.areas where slug = $1',
        [BASE_AREA_SLUGS.northBeach],
      )
      northBeachId = rows[0]?.id as string
      expect(northBeachId).toBeDefined()
      const places = await call(CALLS.placesSearch, { q: 'Dolores', area_id: null }, 'visitor')
      expect(places.length).toBeGreaterThan(0)
      doloresParkId = (places[0] as { id: string }).id
      expect((await call(CALLS.placesGet, { id: doloresParkId }, 'visitor')).id).toBe(doloresParkId)
    })

    it('three Humans through the claim flow: one starts the group, two join it by invite', async () => {
      const first = await claimHuman({
        handle: 'xavier',
        displayName: 'Xavier',
        intent: 'start_group',
        groupLabel: 'Weekend Crew',
      })
      xavier = first.person
      groupId = first.groupId
      groupConversationId = first.conversationId
      expect((await call(CALLS.meGet, {}, xavier.as)).roleKind).toBe('human')

      const invite = await call(
        CALLS.groupsInvitesCreate,
        { group_id: groupId, expires_in_seconds: 7 * 24 * 3600, max_uses: 10 },
        xavier.as,
      )
      inviteToken = invite.token
      const preview = await call(CALLS.groupsInvitesPreview, { token: inviteToken }, 'visitor')
      expect(preview).toMatchObject({ groupName: 'Weekend Crew', alreadyMember: false })

      maya = (
        await claimHuman({
          handle: 'maya',
          displayName: 'Maya',
          intent: 'join_group',
          inviteToken,
        })
      ).person
      kavon = (
        await claimHuman({
          handle: 'kavon',
          displayName: 'Kavon',
          intent: 'join_group',
          inviteToken,
        })
      ).person
      const group = await call(CALLS.groupsGet, { group_id: groupId }, xavier.as)
      expect(group.members.map((member) => member.handle).sort()).toEqual([
        'kavon',
        'maya',
        'xavier',
      ])
    })

    it('identity: identity_update, handle_available, identity_review_create', async () => {
      const identity = await call(
        CALLS.identityUpdate,
        {
          display_name: 'Xavier',
          bio: 'Hello from the parity test',
          avatar_media_id: null,
          profile_visibility: 'public',
          public_city_visibility: true,
          home_city_area_id: sfId,
        },
        xavier.as,
      )
      expect(identity).toMatchObject({ handle: 'xavier', cityName: 'San Francisco' })
      expect(await call(CALLS.identityHandleAvailable, { handle: 'sarah' }, xavier.as)).toBe(true)
      expect(await call(CALLS.identityHandleAvailable, { handle: 'maya' }, xavier.as)).toBe(false)
      const review = await call(
        CALLS.claimCreateReview,
        { kind: 'help', details: { reason: 'parity' } },
        kavon.as,
      )
      expect(review).toMatchObject({ humanId: kavon.humanId, kind: 'help', status: 'open' })
    })

    it('groups: group_update, group_member_set_role, group_invite_join, group_invites_view, group_invite_revoke, group_create, group_leave, group_member_remove', async () => {
      const updated = await call(
        CALLS.groupsUpdate,
        { group_id: groupId, name: 'Weekend Crew', avatar_media_id: null },
        xavier.as,
      )
      expect(updated.myRole).toBe('owner')
      const moderator = await call(
        CALLS.groupsMembersSetRole,
        { group_id: groupId, human_id: maya.humanId, role: 'moderator' },
        xavier.as,
      )
      expect(moderator).toMatchObject({ humanId: maya.humanId, role: 'moderator' })
      const joined = await call(CALLS.groupsInvitesJoin, { token: inviteToken }, maya.as)
      expect(joined).toMatchObject({ groupId, alreadyMember: true })
      const invites = GroupInviteRowsSchema.parse(
        await jsonRows(
          xavier.as,
          `select ${CALLS.groupsInvitesList.args.join(', ')} from public.group_invites_view
            where group_id = $1 order by created_at desc`,
          [groupId],
        ),
      )
      expect(invites.length).toBeGreaterThan(0)
      const second = await call(
        CALLS.groupsInvitesCreate,
        { group_id: groupId, expires_in_seconds: null, max_uses: null },
        maya.as,
      )
      expect(second.token).not.toBe(inviteToken)
      const secondRow = GroupInviteRowsSchema.parse(
        await jsonRows(
          maya.as,
          `select ${CALLS.groupsInvitesList.args.join(', ')} from public.group_invites_view
            where group_id = $1 and created_by = $2`,
          [groupId, maya.humanId],
        ),
      )[0]
      expect(secondRow).toBeDefined()
      const revoked = await call(
        CALLS.groupsInvitesRevoke,
        { invite_id: (secondRow as { id: string }).id },
        xavier.as,
      )
      expect(revoked.status).toBe('revoked')

      const college = await call(CALLS.groupsCreate, { name: 'College' }, kavon.as)
      expect(college.myRole).toBe('owner')
      const left = await call(CALLS.groupsLeave, { group_id: college.id }, kavon.as)
      expect(left).toMatchObject({ groupId: college.id, left: true, archived: true })
      const removed = await call(
        CALLS.groupsMembersRemove,
        { group_id: groupId, human_id: kavon.humanId },
        xavier.as,
      )
      expect(removed).toMatchObject({ groupId, humanId: kavon.humanId, status: 'removed' })
    })

    it('conversations and messages', async () => {
      const dm = await call(
        CALLS.conversationsDirectWith,
        { other_human_id: maya.humanId },
        xavier.as,
      )
      expect(dm.type).toBe('direct')
      dmId = dm.id
      const temporary = await call(
        CALLS.conversationsCreateGroup,
        { human_ids: [maya.humanId, kavon.humanId] },
        xavier.as,
      )
      expect(temporary.type).toBe('group')

      const sent = await call(
        CALLS.messagesSend,
        {
          conversation_id: dmId,
          client_id: randomUUID(),
          type: 'text',
          text: 'hello Maya',
          payload: {},
          reply_to_message_id: null,
        },
        xavier.as,
      )
      messageId = sent.id
      const reply = await call(
        CALLS.messagesSend,
        {
          conversation_id: dmId,
          client_id: randomUUID(),
          type: 'text',
          text: 'hi Xavier',
          payload: {},
          reply_to_message_id: messageId,
        },
        maya.as,
      )
      mayaMessageId = reply.id
      expect(reply.replyToMessageId).toBe(messageId)

      const firstPage = await call(CALLS.conversationsList, { cursor: null, limit: 1 }, xavier.as)
      expect(firstPage.conversations).toHaveLength(1)
      expect(firstPage.nextCursor).not.toBeNull()
      const secondPage = await call(
        CALLS.conversationsList,
        { cursor: firstPage.nextCursor, limit: 20 },
        xavier.as,
      )
      expect(secondPage.conversations.length).toBeGreaterThan(0)
      const all = await call(CALLS.conversationsList, { cursor: null, limit: null }, xavier.as)
      expect(all.conversations.map((c) => c.id)).toEqual(
        expect.arrayContaining([dmId, temporary.id, groupConversationId]),
      )
      const detail = await call(CALLS.conversationsGet, { conversation_id: dmId }, maya.as)
      expect(detail.members.map((m) => m.humanId).sort()).toEqual(
        [xavier.humanId, maya.humanId].sort(),
      )

      const page = await call(
        CALLS.messagesList,
        { conversation_id: dmId, before_id: null, limit: 50 },
        maya.as,
      )
      expect(page.messages.map((m) => m.id)).toEqual([mayaMessageId, messageId])
      const older = await call(
        CALLS.messagesList,
        { conversation_id: dmId, before_id: mayaMessageId, limit: 50 },
        maya.as,
      )
      expect(older.messages.map((m) => m.id)).toEqual([messageId])
      const since = await call(
        CALLS.messagesSince,
        { conversation_id: dmId, after_id: null },
        maya.as,
      )
      expect(since.map((m) => m.id)).toEqual([messageId, mayaMessageId])
      const sinceFirst = await call(
        CALLS.messagesSince,
        { conversation_id: dmId, after_id: messageId },
        maya.as,
      )
      expect(sinceFirst.map((m) => m.id)).toEqual([mayaMessageId])

      const edited = await call(
        CALLS.messagesEdit,
        { message_id: messageId, text: 'hello Maya (edited)' },
        xavier.as,
      )
      expect(edited).toMatchObject({ id: messageId, text: 'hello Maya (edited)' })
      expect(edited.editedAt).not.toBeNull()
      const reacted = await call(
        CALLS.messagesReactionsToggle,
        { message_id: messageId, reaction: '❤️' },
        maya.as,
      )
      expect(reacted.reactions).toEqual([{ reaction: '❤️', count: 1, reactedByMe: true }])
      const read = await call(
        CALLS.conversationsMarkRead,
        { conversation_id: dmId, message_id: mayaMessageId },
        maya.as,
      )
      expect(read).toMatchObject({
        conversationId: dmId,
        lastReadMessageId: mayaMessageId,
        unreadCount: 0,
      })
      const prefs = await call(
        CALLS.conversationsSetPrefs,
        { conversation_id: dmId, mute_state: 'muted', notification_level: 'all' },
        maya.as,
      )
      expect(prefs).toEqual({ conversationId: dmId, muteState: 'muted', notificationLevel: 'all' })
      const receipts = await call(
        CALLS.conversationsReadReceipts,
        { conversation_id: dmId },
        xavier.as,
      )
      expect(receipts.find((r) => r.humanId === maya.humanId)?.lastReadMessageId).toBe(
        mayaMessageId,
      )
      const deleted = await call(CALLS.messagesDelete, { message_id: mayaMessageId }, maya.as)
      expect(deleted).toMatchObject({ id: mayaMessageId, text: null })
      expect(deleted.deletedAt).not.toBeNull()
    })

    it('rooms, guests and Live', async () => {
      const started = await call(
        CALLS.roomsStart,
        { context_type: 'group', context_id: groupId, title: 'Cooking dinner' },
        xavier.as,
      )
      expect(started.created).toBe(true)
      roomId = started.room.id
      const seen = await call(CALLS.roomsGet, { room_id: roomId }, maya.as)
      expect(seen.contextTitle).toBe('Weekend Crew')
      const joined = await call(
        CALLS.roomsJoin,
        { room_id: roomId, media_state: 'camera', consent_level: 'group' },
        maya.as,
      )
      expect(joined.myParticipant).toMatchObject({ mediaState: 'camera', status: 'active' })
      const downgraded = await call(
        CALLS.roomsSetMediaState,
        { room_id: roomId, media_state: 'watching', consent_level: null },
        maya.as,
      )
      expect(downgraded.visibility).toBe('group')
      const consented = await call(
        CALLS.roomsConsent,
        { room_id: roomId, level: 'friends' },
        maya.as,
      )
      expect(consented.applied).toBe(false)
      const opened = await call(
        CALLS.roomsSetVisibility,
        { room_id: roomId, visibility: 'world', join_policy: 'request' },
        xavier.as,
      )
      expect(opened).toMatchObject({ applied: true, visibility: 'world', pendingVisibility: null })
      const policy = await call(
        CALLS.roomsSetJoinPolicy,
        { room_id: roomId, join_policy: 'request' },
        xavier.as,
      )
      expect(policy.joinPolicy).toBe('request')
      const guestsAllowed = await call(
        CALLS.roomsSetGuestsDisabled,
        { room_id: roomId, disabled: false },
        xavier.as,
      )
      expect(guestsAllowed.guestsDisabled).toBe(false)

      const invite = await call(
        CALLS.roomsInvitesCreate,
        { room_id: roomId, expires_in_seconds: 3600, join_policy_override: null },
        xavier.as,
      )
      roomToken = invite.token
      const preview = await call(CALLS.roomsInvitesPreview, { token: roomToken }, 'visitor')
      expect(preview).toMatchObject({ roomId, guestsAllowed: true, ended: false })

      const guestUserId = await db.createAuthUser({ isAnonymous: true })
      guest = { userId: guestUserId, isAnonymous: true }
      const session = await call(
        CALLS.guestCreateSession,
        {
          token: roomToken,
          display_name: 'Sam',
          device_fingerprint_hash: 'fp-parity',
          media_state: 'audio',
        },
        guest,
      )
      expect(session).toMatchObject({ roomId, displayName: 'Sam' })
      const sessions = await call(CALLS.guestGet, {}, guest)
      expect(sessions.sessions.map((s) => s.guestSessionId)).toContain(session.guestSessionId)
      expect(sessions.roomsJoined).toBe(1)
      expect((await call(CALLS.meGet, {}, guest)).roleKind).toBe('guest')
      const guestReport = await call(
        CALLS.safetyReport,
        { target_type: 'room', target_id: roomId, reason: 'harassment', details: null },
        guest,
      )
      expect(guestReport.status).toBe('open')

      const waiting = await call(
        CALLS.roomsJoin,
        { room_id: roomId, media_state: 'camera', consent_level: 'world' },
        kavon.as,
      )
      expect(waiting.myParticipant?.status).toBe('waiting')
      const seatId = waiting.myParticipant?.id as string
      const admitted = await call(
        CALLS.roomsAdmit,
        { room_id: roomId, participant_id: seatId },
        xavier.as,
      )
      expect(admitted.participants.find((p) => p.id === seatId)?.status).toBe('active')
      const kavonLeft = await call(CALLS.roomsLeave, { room_id: roomId }, kavon.as)
      expect(kavonLeft.transferredTo).toBeNull()
      const rejoined = await call(
        CALLS.roomsJoinWithInvite,
        { token: roomToken, media_state: 'watching', consent_level: 'invited' },
        kavon.as,
      )
      expect(rejoined.myParticipant?.status).toBe('active')
      const removed = await call(
        CALLS.roomsRemoveParticipant,
        { room_id: roomId, participant_id: rejoined.myParticipant?.id, block_from_room: false },
        xavier.as,
      )
      // A removed seat is not a participant any more: it is gone from the room's list.
      expect(removed.participants.filter((p) => p.humanId === kavon.humanId)).toEqual([])
      const mayaLeft = await call(CALLS.roomsLeave, { room_id: roomId }, maya.as)
      expect(mayaLeft.transferredTo).toBeNull()
      const ended = await call(CALLS.roomsEnd, { room_id: roomId, reason: 'done' }, xavier.as)
      expect(ended.status).toBe('ended')
    })

    it('posts: post_create with media and provenance, post_get, post_replies, post_reaction_set, post_hide, post_delete', async () => {
      const media = MediaObjectRowSchema.parse(
        await db.asRole(xavier.as, async (client) => {
          const { rows } = await client.query<{ row: unknown }>(
            `with ins as (
               insert into public.media_objects
                 (${CALLS.mediaUpload.args.join(', ')})
               values ($1, 'media', $2, 'image/jpeg', 640, 480, null, 12345)
               returning id, bucket, storage_key, content_type
             )
             select to_jsonb(ins) as row from ins`,
            [xavier.humanId, `${xavier.humanId}/${randomUUID()}.jpg`],
          )
          return rows[0]?.row
        }),
      )
      const post = await call(
        CALLS.postsCreate,
        {
          type: 'image',
          text: 'Dolores Park this afternoon',
          audience: 'world',
          area_id: null,
          place_id: doloresParkId,
          media: [media.id],
          reply_policy: 'everyone_eligible',
          reshare_policy: 'allowed_within_audience',
          parent_post_id: null,
          provenance: ['earth_capture'],
        },
        xavier.as,
      )
      expect(post).toMatchObject({
        authorHumanId: xavier.humanId,
        type: 'image',
        placeId: doloresParkId,
      })
      postId = post.id
      const reply = await call(
        CALLS.postsCreate,
        {
          type: 'text',
          text: 'Looks great',
          audience: 'world',
          area_id: null,
          place_id: null,
          media: [],
          reply_policy: 'everyone_eligible',
          reshare_policy: 'allowed_within_audience',
          parent_post_id: postId,
          provenance: [],
        },
        maya.as,
      )
      expect(reply.parentPostId).toBe(postId)
      replyId = reply.id

      const detail = await call(CALLS.postsGet, { post_id: postId }, kavon.as)
      expect(detail.media).toHaveLength(1)
      expect(detail.media[0]?.provenance).toBe('earth_capture')
      expect(detail.replies.map((view) => view.post.id)).toEqual([replyId])
      expect((await call(CALLS.postsGet, { post_id: postId }, 'visitor')).post.id).toBe(postId)
      const replies = await call(
        CALLS.postsReplies,
        { post_id: postId, cursor: null, limit: 20 },
        kavon.as,
      )
      expect(replies.replies.map((view) => view.post.id)).toEqual([replyId])
      expect(replies.nextCursor).toBeNull()
      const liked = await call(
        CALLS.postsReact,
        { post_id: postId, reaction_type: 'like' },
        maya.as,
      )
      expect(liked).toEqual({ postId, myReaction: 'like', reactionCount: 1 })
      const cleared = await call(
        CALLS.postsReact,
        { post_id: postId, reaction_type: null },
        maya.as,
      )
      expect(cleared).toEqual({ postId, myReaction: null, reactionCount: 0 })
      await call(CALLS.postsHide, { post_id: postId }, kavon.as)
      await call(CALLS.postsDelete, { post_id: replyId }, maya.as)
      expect((await call(CALLS.postsGet, { post_id: postId }, xavier.as)).replyCount).toBe(0)
      const byAuthor = await call(
        CALLS.postsByAuthor,
        { handle: 'xavier', cursor: null, limit: 20 },
        maya.as,
      )
      expect(byAuthor.posts.map((view) => view.post.id)).toEqual([postId])
      expect(byAuthor.nextCursor).toBeNull()
      // Visitors reach the world posts of a public profile.
      expect(
        (
          await call(CALLS.postsByAuthor, { handle: 'xavier', cursor: null, limit: 20 }, 'visitor')
        ).posts.map((view) => view.post.id),
      ).toEqual([postId])
    })

    it('social graph, blocks and profiles', async () => {
      const requested = await call(
        CALLS.socialFriendRequest,
        { target_human_id: maya.humanId },
        xavier.as,
      )
      expect(requested).toMatchObject({
        humanId: maya.humanId,
        isFriend: false,
        friendRequest: 'sent',
      })
      const accepted = await call(
        CALLS.socialAcceptFriend,
        { source_human_id: xavier.humanId },
        maya.as,
      )
      expect(accepted).toMatchObject({ humanId: xavier.humanId, isFriend: true })
      await call(CALLS.socialFriendRequest, { target_human_id: kavon.humanId }, xavier.as)
      await call(CALLS.socialAcceptFriend, { source_human_id: xavier.humanId }, kavon.as)
      const removed = await call(
        CALLS.socialRemoveFriend,
        { other_human_id: kavon.humanId },
        xavier.as,
      )
      expect(removed).toMatchObject({ humanId: kavon.humanId, isFriend: false })
      await call(CALLS.socialFriendRequest, { target_human_id: kavon.humanId }, maya.as)
      const declined = await call(
        CALLS.socialDeclineFriend,
        { source_human_id: maya.humanId },
        kavon.as,
      )
      expect(declined).toMatchObject({
        humanId: maya.humanId,
        isFriend: false,
        friendRequest: 'none',
      })
      const following = await call(
        CALLS.socialSetFollow,
        { target_human_id: kavon.humanId, following: true },
        xavier.as,
      )
      expect(following.isFollowing).toBe(true)
      const unfollowed = await call(
        CALLS.socialSetFollow,
        { target_human_id: kavon.humanId, following: false },
        xavier.as,
      )
      expect(unfollowed.isFollowing).toBe(false)
      const blocked = await call(
        CALLS.socialBlock,
        { target_human_id: kavon.humanId, blocked: true },
        xavier.as,
      )
      expect(blocked).toMatchObject({ humanId: kavon.humanId, isBlocked: true })
      const blocks = await call(CALLS.socialBlocks, {}, xavier.as)
      expect(blocks.blocks.map((b) => b.blockedHumanId)).toEqual([kavon.humanId])
      const unblocked = await call(
        CALLS.socialUnblock,
        { target_human_id: kavon.humanId, blocked: false },
        xavier.as,
      )
      expect(unblocked.isBlocked).toBe(false)
      expect((await call(CALLS.socialBlocks, {}, xavier.as)).blocks).toEqual([])

      const profile = await call(CALLS.socialProfile, { handle: 'maya' }, xavier.as)
      expect(profile.identity.handle).toBe('maya')
      expect(profile.relationship.isFriend).toBe(true)
      const publicProfile = await call(CALLS.socialProfile, { handle: 'xavier' }, 'visitor')
      expect(publicProfile.relationship.isSelf).toBe(false)
      expect(publicProfile.canMessage).toBe(false)
    })

    it('search', async () => {
      const results = await call(CALLS.searchQuery, { q: 'maya', limit: 10 }, xavier.as)
      expect(results.people.map((p) => p.handle)).toContain('maya')
      const publicResults = await call(CALLS.searchQuery, { q: 'Dolores', limit: 10 }, 'visitor')
      expect(publicResults.places.length).toBeGreaterThan(0)
    })

    it('notifications, push tokens and presence', async () => {
      const page = await call(CALLS.notificationsList, { cursor: null, limit: 1 }, maya.as)
      expect(page.notifications).toHaveLength(1)
      expect(page.nextCursor).not.toBeNull()
      const next = await call(
        CALLS.notificationsList,
        { cursor: page.nextCursor, limit: 20 },
        maya.as,
      )
      expect(next.notifications.length).toBeGreaterThan(0)
      const first = page.notifications[0] as { id: string }
      await call(CALLS.notificationsMarkRead, { id: first.id }, maya.as)
      const unread = await call(CALLS.notificationsUnreadCount, {}, maya.as)
      expect(unread.unreadCount).toBe(page.unreadCount - 1)
      await call(CALLS.notificationsMarkAllRead, {}, maya.as)
      expect((await call(CALLS.notificationsUnreadCount, {}, maya.as)).unreadCount).toBe(0)
      await call(
        CALLS.notificationsRegisterPushToken,
        { token: 'ExponentPushToken[parity]', platform: 'ios' },
        maya.as,
      )
      await call(
        CALLS.notificationsRemovePushToken,
        { token: 'ExponentPushToken[parity]' },
        maya.as,
      )
      await call(
        CALLS.presencePing,
        { conversation_id: dmId, room_id: null, platform: 'ios' },
        xavier.as,
      )
    })

    it('location: area_resolve, context_set, context_resolve_and_set, scope_set, place_create, shares, map_objects', async () => {
      const resolution = await call(CALLS.locationResolveArea, POINTS.northBeach, xavier.as)
      expect(resolution.city?.id).toBe(sfId)
      expect(resolution.neighborhood?.id).toBe(northBeachId)
      const context = await call(
        CALLS.locationSetContext,
        { current_area_id: northBeachId, current_city_id: sfId, home_city_id: sfId },
        xavier.as,
      )
      expect(context).toMatchObject({
        currentAreaId: northBeachId,
        currentCityId: sfId,
        homeCityId: sfId,
      })
      const resolved = await call(
        CALLS.locationResolveAndSetContext,
        POINTS.goldenGatePark,
        xavier.as,
      )
      expect(resolved).toMatchObject({ currentCityId: sfId, currentCityName: 'San Francisco' })
      await call(CALLS.locationSetScope, { surface: 'home', scope: 'city' }, xavier.as)
      const cafe = await call(
        CALLS.placesCreate,
        {
          name: 'Parity Cafe',
          lat: POINTS.mission.lat,
          lng: POINTS.mission.lng,
          area_id: sfId,
          category: 'cafe',
        },
        xavier.as,
      )
      expect(cafe).toMatchObject({ name: 'Parity Cafe', category: 'cafe' })

      const share = await call(
        CALLS.locationShare,
        {
          audience_type: 'friend',
          audience_id: maya.humanId,
          precision: 'precise',
          duration_seconds: 3600,
          lat: POINTS.northBeach.lat,
          lng: POINTS.northBeach.lng,
        },
        xavier.as,
      )
      expect(share).toMatchObject({
        humanId: xavier.humanId,
        audienceId: maya.humanId,
        revokedAt: null,
      })
      shareId = share.id
      const updated = await call(
        CALLS.locationUpdateShare,
        { share_id: shareId, lat: POINTS.mission.lat, lng: POINTS.mission.lng },
        xavier.as,
      )
      expect(updated.id).toBe(shareId)
      const mine = await call(CALLS.locationMyShares, {}, xavier.as)
      expect(mine.map((s) => s.id)).toEqual([shareId])
      expect(await call(CALLS.locationMyShares, {}, maya.as)).toEqual([])
      const visible = await call(CALLS.locationVisibleShares, {}, maya.as)
      expect(visible.map((s) => s.humanId)).toEqual([xavier.humanId])
      const objects = await call(CALLS.mapObjects, { scope: 'friends', ...SF_BBOX }, maya.as)
      expect(objects.friends.map((f) => f.humanId)).toEqual([xavier.humanId])
      const world = await call(CALLS.mapObjects, { scope: 'world', ...SF_BBOX }, 'visitor')
      expect(world.places.length).toBeGreaterThan(0)
      const revoked = await call(CALLS.locationRevokeShare, { share_id: shareId }, xavier.as)
      expect(revoked.revokedAt).not.toBeNull()
      expect(await call(CALLS.locationVisibleShares, {}, maya.as)).toEqual([])
    })

    it('safety: report_create and reports_mine', async () => {
      const report = await call(
        CALLS.safetyReport,
        { target_type: 'post', target_id: postId, reason: 'harassment', details: 'parity' },
        maya.as,
      )
      expect(report.status).toBe('open')
      const mine = await call(CALLS.safetyMyReports, {}, maya.as)
      expect(mine.map((r) => r.id)).toEqual([report.id])
    })

    it('every RPC the manifest names was exercised above', () => {
      expect([...MANIFEST_RPC_NAMES].filter((name) => !exercised.has(name))).toEqual([])
    })
  })
})
