/**
 * Adversarial verification of the "rooms" invariant cluster (spec §32–§36, §42–§43, §57–§62, §83,
 * §105, SCREEN 13–18; ARCHITECTURE §4, §10, §12; DB_API §3):
 *
 *   - Live is a Room state: there is no second table; a pending widening is not a Live yet; an
 *     ended room is gone from every scope however it ended.
 *   - Naming follows the participants: payloads track joins, upgrades and leaves; watchers,
 *     waiting and invited seats never surface outward.
 *   - Consent gates every publish, with no hidden audience inheritance: not through admission of a
 *     waiting seat after a widening, not through the LiveKit reconciler re-seating a stale row, not
 *     through a moderator's own consent, and the media grant never says `canPublish` beyond it.
 *   - Moderator transfer never lands on a Guest, in any path; the initiator outranks moderators.
 *   - Grace-period end is measured from the last active Human and honours the setting.
 *   - The token grant never exceeds the seat (status, media state, role, consent, Human status).
 *   - Guests cannot expand, invite, moderate, discover or DM; a temporary "guests disabled" is not
 *     a block; GUEST_ROOMS_ENABLED is a kill switch.
 *   - Join policy is enforced on the first publish, not only on the first entry; every
 *     (visibility, join policy) pair the database accepts is one the domain offers.
 *   - Feature flags gate widening, discovery and Guests — including a widening that was pending
 *     when the flag went off.
 *   - Blocks and group membership hold inside live rooms: the reconciler never re-seats a blocked
 *     pair, a removed group member loses the group's room.
 *
 * Every test is a concrete sequence of RPC calls as specific callers; raw SQL only sets up state no
 * RPC can produce (areas, a suspended Human, a corrupted consent row) or plays the service.
 */
import {
  MediaGrantDtoSchema,
  ROOM_JOIN_POLICY,
  ROOM_VISIBILITY,
  RoomDtoSchema,
  RoomLeaveDtoSchema,
  RoomVisibilityChangeDtoSchema,
  allowedJoinPoliciesFor,
  isJoinPolicyAllowedFor,
  type RoomJoinPolicy,
  type RoomVisibility,
} from '@earth/domain'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  addMember,
  befriend,
  block,
  count,
  createArea,
  createGroup,
  createGuest,
  createGuestSession,
  createHuman,
  createRoomInvite,
  createUnclaimed,
  directConversation,
  getRoom,
  human,
  joinRoom,
  participantId,
  participantStatus,
  roomRow,
  rpcAt,
  scalar,
  secondsFromNow,
  setContext,
  setFlag,
  setSetting,
  startGroupRoom,
  startStandaloneRoom,
  type Guest,
  type GroupFixture,
  type Human,
} from '../rooms/fixtures'
import { errorCode, resetAllRateLimits } from '../safety/fixtures'

const PERMISSION_DENIED = '42501'
const CHECK_VIOLATION = '23514'

interface Candidate {
  roomId: string
  participantCount: number
  participants: Array<{
    humanId: string | null
    displayName: string
    isGuest: boolean
    relationToViewer: string | null
  }>
}

async function liveList(db: TestDb, scope: string, as: RoleSpec): Promise<Candidate[]> {
  const list = await db.rpc<{ candidates: Candidate[] }>(
    'live_candidates',
    { scope, area_id: null },
    as,
  )
  return list.candidates
}

async function liveIds(db: TestDb, scope: string, as: RoleSpec): Promise<string[]> {
  return (await liveList(db, scope, as)).map((c) => c.roomId).sort()
}

async function grant(db: TestDb, roomId: string, as: RoleSpec) {
  return MediaGrantDtoSchema.parse(await db.rpc('room_media_grant', { room_id: roomId }, as))
}

async function sync(
  db: TestDb,
  roomId: string,
  identity: string,
  event: string,
  at: string | null = null,
) {
  return db.rpc<{
    applied: boolean
    ignored: boolean
    reason: string | null
    transferredTo?: string | null
  }>('room_participant_sync', { room_id: roomId, livekit_identity: identity, event, at }, 'service')
}

async function rowsAs<T extends Record<string, unknown>>(
  db: TestDb,
  as: RoleSpec,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  return db.asRole(as, async (c) => (await c.query<T>(sql, values)).rows)
}

/** Publisher display names as an outsider sees them through room_get. */
async function publishersSeenBy(db: TestDb, roomId: string, as: RoleSpec): Promise<string[]> {
  return (await getRoom(db, roomId, as)).participants.map((p) => p.displayName)
}

async function sqlErrorCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    if (error instanceof pg.DatabaseError) return error.code ?? null
    throw error
  }
}

let handles = 0
const nextHandle = (prefix: string): string => `${prefix}${(handles += 1)}`

describe('rooms invariants — adversarial verification', () => {
  let db: TestDb

  beforeAll(async () => {
    db = await createTestDb()
  })

  beforeEach(async () => {
    await resetAllRateLimits(db)
  })

  afterAll(async () => {
    await db.drop()
  })

  // -------------------------------------------------------------------------------------------
  describe('Live is a Room state', () => {
    it('there is no second live/stream table: discovery reads rooms', async () => {
      const { rows } = await db.sql.query<{ tablename: string }>(
        `select tablename from pg_tables where schemaname = 'public' and (tablename like 'live%' or tablename like '%stream%')`,
      )
      expect(rows).toEqual([])
      const { rows: fn } = await db.sql.query<{ src: string }>(
        `select prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'live_candidates'`,
      )
      expect(fn[0]?.src).toContain('from public.rooms r')
    })

    it('a pending widening is not a Live: nobody outside the context sees the room until every publisher consented', async () => {
      const owner = await human(db, 'Pendowner')
      const member = await human(db, 'Pendmember')
      const friend = await human(db, 'Pendfriend')
      const group = await createGroup(db, owner, 'Pending Crew')
      await addMember(db, group, member)
      await befriend(db, owner, friend)
      const roomId = (await startGroupRoom(db, owner, group)).room.id
      await joinRoom(db, roomId, member, 'camera', 'group')
      const change = RoomVisibilityChangeDtoSchema.parse(
        await db.rpc('room_set_visibility', { room_id: roomId, visibility: 'friends' }, owner.as),
      )
      expect(change.applied).toBe(false)
      expect(await roomRow(db, roomId)).toMatchObject({
        visibility: 'group',
        pending_visibility: 'friends',
      })
      // The room is not a friends Live yet, on any surface.
      expect(await liveIds(db, 'friends', friend.as)).not.toContain(roomId)
      await db.expectError(db.rpc('room_get', { room_id: roomId }, friend.as), 'room_not_found')
      expect(
        await rowsAs(db, friend.as, 'select id from public.rooms where id = $1', [roomId]),
      ).toEqual([])
      expect(
        await rowsAs(db, friend.as, 'select id from public.room_participants where room_id = $1', [
          roomId,
        ]),
      ).toEqual([])
      // The member consenting flips it on every surface at once.
      const applied = RoomVisibilityChangeDtoSchema.parse(
        await db.rpc('room_consent', { room_id: roomId, level: 'friends' }, member.as),
      )
      expect(applied).toMatchObject({
        applied: true,
        visibility: 'friends',
        pendingVisibility: null,
      })
      expect(await liveIds(db, 'friends', friend.as)).toContain(roomId)
      expect((await getRoom(db, roomId, friend.as)).visibility).toBe('friends')
      await db.rpc('room_end', { room_id: roomId }, owner.as)
    })

    it('an ended room is gone from every scope and pointer however it ended (moderator, reconciler, sweep)', async () => {
      const host = await human(db, 'Endhost')
      const friend = await human(db, 'Endfriend')
      await befriend(db, host, friend)
      const stranger = await human(db, 'Endstranger')
      const a = (await startStandaloneRoom(db, host, 'A')).room.id
      const b = (await startStandaloneRoom(db, host, 'B')).room.id
      const c = (await startStandaloneRoom(db, host, 'C')).room.id
      for (const id of [a, b, c])
        await db.rpc('room_set_visibility', { room_id: id, visibility: 'world' }, host.as)
      expect(await liveIds(db, 'world', 'visitor')).toEqual(expect.arrayContaining([a, b, c]))
      expect(await liveIds(db, 'friends', friend.as)).toEqual(expect.arrayContaining([a, b, c]))

      await db.rpc('room_end', { room_id: a }, host.as)
      expect((await sync(db, b, '', 'room_finished')).applied).toBe(true)
      await db.rpc('room_leave', { room_id: c }, host.as)
      expect(
        (await db.rpc<{ roomsEnded: number }>('rooms_sweep', {}, 'service')).roomsEnded,
      ).toBeGreaterThanOrEqual(1)

      for (const id of [a, b, c]) {
        expect(await roomRow(db, id)).toMatchObject({
          status: 'ended',
          active_participant_count: 0,
        })
        expect(await liveIds(db, 'world', 'visitor')).not.toContain(id)
        expect(await liveIds(db, 'world', stranger.as)).not.toContain(id)
        expect(await liveIds(db, 'friends', friend.as)).not.toContain(id)
        await db.expectError(db.rpc('room_get', { room_id: id }, 'visitor'), 'room_not_found')
        await db.expectError(db.rpc('room_get', { room_id: id }, stranger.as), 'room_not_found')
        // Nobody can take a seat: the room does not exist for someone who never had one, and is
        // over for someone who did.
        await db.expectError(
          db.rpc('room_join', { room_id: id, media_state: 'watching' }, friend.as),
          'room_not_found',
        )
        await db.expectError(
          db.rpc(
            'room_join',
            { room_id: id, media_state: 'camera', consent_level: 'world' },
            host.as,
          ),
          'room_ended',
        )
        // A former participant keeps the history, nobody else.
        expect((await getRoom(db, id, host.as)).status).toBe('ended')
      }
      expect(
        await scalar(
          db,
          'count(*) from public.human_presence where active_room_id in ($1, $2, $3)',
          [a, b, c],
        ),
      ).toBe('0')
    })

    it('invited and group rooms never surface in discovery, even for friends of every publisher', async () => {
      const owner = await human(db, 'Ctxowner')
      const friend = await human(db, 'Ctxfriend')
      await befriend(db, owner, friend)
      const group = await createGroup(db, owner, 'Ctx Crew')
      const groupRoom = (await startGroupRoom(db, owner, group)).room.id
      const dm = await directConversation(db, owner, await human(db, 'Ctxdm'))
      const directRoom = (
        await db.rpc<{ room: { id: string } }>(
          'room_start',
          { context_type: 'direct', context_id: dm },
          owner.as,
        )
      ).room.id
      for (const scope of ['friends', 'world'] as const) {
        expect(await liveIds(db, scope, friend.as)).not.toContain(groupRoom)
        expect(await liveIds(db, scope, friend.as)).not.toContain(directRoom)
      }
      await db.expectError(db.rpc('room_get', { room_id: groupRoom }, friend.as), 'room_not_found')
      await db.expectError(db.rpc('room_get', { room_id: directRoom }, friend.as), 'room_not_found')
      expect(
        await rowsAs(db, friend.as, 'select id from public.rooms where id in ($1, $2)', [
          groupRoom,
          directRoom,
        ]),
      ).toEqual([])
      await db.rpc('room_end', { room_id: groupRoom }, owner.as)
      await db.rpc('room_end', { room_id: directRoom }, owner.as)
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('naming follows the participants', () => {
    it('payloads track joins, upgrades, guests and leaves; watchers never surface outward', async () => {
      const host = await human(db, 'Nhost')
      const viewer = await human(db, 'Nviewer')
      const outsider = await human(db, 'Noutsider')
      await befriend(db, host, viewer)
      await befriend(db, host, outsider)
      const roomId = (await startStandaloneRoom(db, host, 'Naming')).room.id
      expect(await publishersSeenBy(db, roomId, outsider.as)).toEqual(['Nhost'])

      await joinRoom(db, roomId, viewer, 'watching')
      expect(await publishersSeenBy(db, roomId, outsider.as)).toEqual(['Nhost'])
      let list = (await liveList(db, 'friends', outsider.as)).find((c) => c.roomId === roomId)
      expect(list).toMatchObject({ participantCount: 1 })
      expect(list?.participants.map((p) => p.displayName)).toEqual(['Nhost'])

      await db.rpc(
        'room_set_media_state',
        { room_id: roomId, media_state: 'audio', consent_level: 'friends' },
        viewer.as,
      )
      expect(await publishersSeenBy(db, roomId, outsider.as)).toEqual(['Nhost', 'Nviewer'])
      list = (await liveList(db, 'friends', outsider.as)).find((c) => c.roomId === roomId)
      expect(list?.participantCount).toBe(2)
      expect(list?.participants.map((p) => [p.displayName, p.relationToViewer])).toEqual([
        ['Nhost', 'friend'],
        ['Nviewer', 'other'],
      ])

      const invite = await createRoomInvite(db, roomId, host)
      const guest = await createGuest(db)
      await createGuestSession(db, guest, invite.token, 'Sam', { mediaState: 'camera' })
      expect(await publishersSeenBy(db, roomId, outsider.as)).toEqual(['Nhost', 'Nviewer', 'Sam'])
      const room = await getRoom(db, roomId, outsider.as)
      expect(
        room.participants.map((p) => [p.isGuest, p.humanId === null, p.guestSessionId !== null]),
      ).toEqual([
        [false, false, false],
        [false, false, false],
        [true, true, true],
      ])

      await db.rpc('room_set_media_state', { room_id: roomId, media_state: 'watching' }, viewer.as)
      expect(await publishersSeenBy(db, roomId, outsider.as)).toEqual(['Nhost', 'Sam'])
      await db.rpc('room_leave', { room_id: roomId }, guest.as)
      expect(await publishersSeenBy(db, roomId, outsider.as)).toEqual(['Nhost'])
      // Inside the room the watcher is listed; outside it never is, under RLS either.
      expect((await getRoom(db, roomId, host.as)).participants.map((p) => p.displayName)).toEqual([
        'Nhost',
        'Nviewer',
      ])
      expect(
        await rowsAs(
          db,
          outsider.as,
          'select human_id from public.room_participants where room_id = $1 and human_id = $2',
          [roomId, viewer.humanId],
        ),
      ).toEqual([])
      await db.rpc('room_end', { room_id: roomId }, host.as)
    })

    it('waiting and invited seats are named only inside the room', async () => {
      const host = await human(db, 'Whost')
      const requester = await human(db, 'Wrequester')
      const outsider = await human(db, 'Woutsider')
      const roomId = (await startStandaloneRoom(db, host)).room.id
      await db.rpc(
        'room_set_visibility',
        { room_id: roomId, visibility: 'world', join_policy: 'request' },
        host.as,
      )
      const waiting = await joinRoom(db, roomId, requester, 'camera', 'world')
      expect(waiting.myParticipant?.status).toBe('waiting')
      expect(await publishersSeenBy(db, roomId, outsider.as)).toEqual(['Whost'])
      expect(await publishersSeenBy(db, roomId, 'visitor')).toEqual(['Whost'])
      expect(
        (await liveList(db, 'world', outsider.as)).find((c) => c.roomId === roomId)
          ?.participantCount,
      ).toBe(1)
      expect(
        (await getRoom(db, roomId, host.as)).participants.map((p) => [p.displayName, p.status]),
      ).toEqual([
        ['Whost', 'active'],
        ['Wrequester', 'waiting'],
      ])
      expect(
        await rowsAs(
          db,
          outsider.as,
          'select id from public.room_participants where room_id = $1 and human_id = $2',
          [roomId, requester.humanId],
        ),
      ).toEqual([])
      await db.rpc('room_end', { room_id: roomId }, host.as)
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('consent gating — no hidden audience inheritance', () => {
    it('admitting a waiting seat after a widening never puts it on camera beyond its consent', async () => {
      const host = await human(db, 'Adhost')
      const friend = await human(db, 'Adfriend')
      const outsider = await human(db, 'Adoutsider')
      await befriend(db, host, friend)
      const roomId = (await startStandaloneRoom(db, host)).room.id
      await db.rpc(
        'room_set_visibility',
        { room_id: roomId, visibility: 'friends', join_policy: 'request' },
        host.as,
      )
      const request = await joinRoom(db, roomId, friend, 'camera', 'friends')
      expect(request.myParticipant).toMatchObject({
        status: 'waiting',
        mediaState: 'camera',
        audienceConsentLevel: 'friends',
      })
      const seatId = request.myParticipant?.id

      // The waiting seat is not a publisher: the room opens to the world at once.
      const opened = RoomVisibilityChangeDtoSchema.parse(
        await db.rpc(
          'room_set_visibility',
          { room_id: roomId, visibility: 'world', join_policy: 'request' },
          host.as,
        ),
      )
      expect(opened.applied).toBe(true)
      await db.rpc('room_admit', { room_id: roomId, participant_id: seatId }, host.as)

      // Admitted, but never on camera at `world` without saying so.
      const seat = await participantStatus(db, roomId, friend.humanId)
      expect(seat?.status).toBe('active')
      expect(seat?.media_state).toBe('watching')
      expect((await grant(db, roomId, friend.as)).canPublish).toBe(false)
      expect(await publishersSeenBy(db, roomId, outsider.as)).toEqual(['Adhost'])
      expect(await publishersSeenBy(db, roomId, 'visitor')).toEqual(['Adhost'])
      await db.expectError(
        db.rpc('room_set_media_state', { room_id: roomId, media_state: 'camera' }, friend.as),
        'consent_required',
      )
      // Explicit consent, then camera: the seat was admitted, so no second request.
      await db.rpc(
        'room_set_media_state',
        { room_id: roomId, media_state: 'camera', consent_level: 'world' },
        friend.as,
      )
      expect(await participantStatus(db, roomId, friend.humanId)).toMatchObject({
        status: 'active',
        media_state: 'camera',
        consent: 'world',
      })
      expect((await grant(db, roomId, friend.as)).canPublish).toBe(true)
      await db.rpc('room_end', { room_id: roomId }, host.as)
    })

    it('the LiveKit reconciler never re-seats a stale row on camera beyond its consent', async () => {
      const host = await human(db, 'Synchost')
      const cohost = await human(db, 'Synccohost')
      const outsider = await human(db, 'Syncoutsider')
      await befriend(db, host, cohost)
      const roomId = (await startStandaloneRoom(db, host)).room.id
      await joinRoom(db, roomId, cohost, 'camera', 'world')
      // The host (consent = friends) leaves; the cohost keeps the room open and opens it to the world.
      const left = RoomLeaveDtoSchema.parse(
        await db.rpc('room_leave', { room_id: roomId }, host.as),
      )
      expect(left.transferredTo).toBe(cohost.humanId)
      const opened = RoomVisibilityChangeDtoSchema.parse(
        await db.rpc('room_set_visibility', { room_id: roomId, visibility: 'world' }, cohost.as),
      )
      expect(opened.applied).toBe(true)

      // The host's client reconnects to LiveKit with its old token: the webhook must not put the
      // host on camera at `world` with a `friends` consent.
      const rejoined = await sync(
        db,
        roomId,
        `h:${host.humanId}`,
        'participant_joined',
        secondsFromNow(1),
      )
      const seat = await participantStatus(db, roomId, host.humanId)
      if (rejoined.applied) {
        expect(seat?.status).toBe('active')
        expect(seat?.media_state).toBe('watching')
        expect((await grant(db, roomId, host.as)).canPublish).toBe(false)
      } else {
        expect(seat?.status).toBe('left')
      }
      expect(await publishersSeenBy(db, roomId, outsider.as)).toEqual(['Synccohost'])
      expect(await publishersSeenBy(db, roomId, 'visitor')).toEqual(['Synccohost'])
      await db.rpc('room_end', { room_id: roomId }, cohost.as)
    })

    it('a moderator opening up consents for nobody else — audio publishers included', async () => {
      const owner = await human(db, 'Cowner')
      const audio = await human(db, 'Caudio')
      const camera = await human(db, 'Ccamera')
      const group = await createGroup(db, owner, 'Consent Crew')
      await addMember(db, group, audio)
      await addMember(db, group, camera)
      const roomId = (await startGroupRoom(db, owner, group)).room.id
      const a = await joinRoom(db, roomId, audio, 'audio', 'group')
      const c = await joinRoom(db, roomId, camera, 'camera', 'group')
      const pending = RoomVisibilityChangeDtoSchema.parse(
        await db.rpc('room_set_visibility', { room_id: roomId, visibility: 'friends' }, owner.as),
      )
      expect(pending.applied).toBe(false)
      expect(pending.pendingParticipantIds.sort()).toEqual(
        [participantId(a, audio.humanId), participantId(c, camera.humanId)].sort(),
      )
      expect(await participantStatus(db, roomId, audio.humanId)).toMatchObject({ consent: 'group' })
      expect(await participantStatus(db, roomId, camera.humanId)).toMatchObject({
        consent: 'group',
      })
      // Opening up is the moderator's own consent only.
      expect(await participantStatus(db, roomId, owner.humanId)).toMatchObject({
        consent: 'friends',
      })
      const half = RoomVisibilityChangeDtoSchema.parse(
        await db.rpc('room_consent', { room_id: roomId, level: 'friends' }, audio.as),
      )
      expect(half).toMatchObject({
        applied: false,
        pendingParticipantIds: [participantId(c, camera.humanId)],
      })
      // A re-join by the pending participant with a low consent changes nothing.
      await joinRoom(db, roomId, camera, 'camera', 'group')
      expect(await roomRow(db, roomId)).toMatchObject({
        visibility: 'group',
        pending_visibility: 'friends',
      })
      const done = RoomVisibilityChangeDtoSchema.parse(
        await db.rpc(
          'room_set_media_state',
          { room_id: roomId, media_state: 'watching' },
          camera.as,
        ),
      )
      expect(done.applied).toBe(true)
      await db.rpc('room_end', { room_id: roomId }, owner.as)
    })

    it('consent is per Human and per level: a viewer with no or a lower consent cannot publish in a wider room', async () => {
      const host = await human(db, 'Lvhost')
      const friend = await human(db, 'Lvfriend')
      await befriend(db, host, friend)
      const roomId = (await startStandaloneRoom(db, host)).room.id
      await db.rpc(
        'room_set_visibility',
        { room_id: roomId, visibility: 'world', join_policy: 'friends' },
        host.as,
      )
      await joinRoom(db, roomId, friend, 'watching')
      await db.expectError(
        db.rpc('room_set_media_state', { room_id: roomId, media_state: 'camera' }, friend.as),
        'consent_required',
      )
      await db.expectError(
        db.rpc(
          'room_set_media_state',
          { room_id: roomId, media_state: 'audio', consent_level: 'city' },
          friend.as,
        ),
        'consent_required',
      )
      await db.expectError(
        db.rpc(
          'room_join',
          { room_id: roomId, media_state: 'camera', consent_level: 'city' },
          friend.as,
        ),
        'consent_required',
      )
      expect((await grant(db, roomId, friend.as)).canPublish).toBe(false)
      await db.rpc(
        'room_set_media_state',
        { room_id: roomId, media_state: 'camera', consent_level: 'world' },
        friend.as,
      )
      expect((await grant(db, roomId, friend.as)).canPublish).toBe(true)
      await db.rpc('room_end', { room_id: roomId }, host.as)
    })

    it('the media grant never says canPublish for a Human whose recorded consent is below the room (defence in depth)', async () => {
      const host = await human(db, 'Dhost')
      const friend = await human(db, 'Dfriend')
      await befriend(db, host, friend)
      const roomId = (await startStandaloneRoom(db, host)).room.id
      await db.rpc(
        'room_set_visibility',
        { room_id: roomId, visibility: 'world', join_policy: 'friends' },
        host.as,
      )
      await joinRoom(db, roomId, friend, 'camera', 'world')
      expect((await grant(db, roomId, friend.as)).canPublish).toBe(true)
      // A row that somehow carries a consent below the visibility (legacy data, an operator edit).
      await db.sql.query(
        `update public.room_participants set audience_consent_level = 'friends' where room_id = $1 and human_id = $2`,
        [roomId, friend.humanId],
      )
      expect((await grant(db, roomId, friend.as)).canPublish).toBe(false)
      await db.rpc('room_end', { room_id: roomId }, host.as)
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('moderator transfer never to Guests; the initiator outranks moderators', () => {
    it('transfer skips Guests and non-active Humans in every path; no Guest row can ever hold a moderator role', async () => {
      const host = await human(db, 'Mhost')
      const watcher = await human(db, 'Mwatcher')
      const requester = await human(db, 'Mrequester')
      await befriend(db, host, watcher)
      const roomId = (await startStandaloneRoom(db, host)).room.id
      await db.rpc(
        'room_set_visibility',
        { room_id: roomId, visibility: 'world', join_policy: 'request' },
        host.as,
      )
      const invite = await createRoomInvite(db, roomId, host)
      const guest = await createGuest(db)
      const session = await createGuestSession(db, guest, invite.token, 'Sam', {
        mediaState: 'camera',
      })
      await joinRoom(db, roomId, watcher, 'watching')
      expect((await joinRoom(db, roomId, requester, 'camera', 'world')).myParticipant?.status).toBe(
        'waiting',
      )

      // room_leave: the Guest joined before the watcher and publishes; the watcher still wins.
      const left = RoomLeaveDtoSchema.parse(
        await db.rpc('room_leave', { room_id: roomId }, host.as),
      )
      expect(left.transferredTo).toBe(watcher.humanId)
      expect((await grant(db, roomId, watcher.as)).role).toBe('moderator')
      expect((await grant(db, roomId, guest.as)).role).toBe('participant')
      // The reconciler: the watcher drops; only the Guest and a waiting Human remain → nobody.
      const dropped = await sync(
        db,
        roomId,
        `h:${watcher.humanId}`,
        'participant_left',
        secondsFromNow(1),
      )
      expect(dropped).toMatchObject({ applied: true, transferredTo: null })
      expect(
        await count(
          db,
          'public.room_participants',
          "room_id = $1 and status = 'active' and role in ('initiator', 'moderator')",
          [roomId],
        ),
      ).toBe(0)
      expect(
        await scalar(
          db,
          "role::text from public.room_participants where guest_session_id = $1 and status = 'active'",
          [session.guestSessionId],
        ),
      ).toBe('participant')
      // Not even the database owner can give a Guest row a moderator role.
      expect(
        await sqlErrorCode(
          db.sql.query(
            `update public.room_participants set role = 'moderator' where guest_session_id = $1`,
            [session.guestSessionId],
          ),
        ),
      ).toBe(CHECK_VIOLATION)
      // A Human coming back takes the room over (spec §61: Guests cannot own the room).
      await joinRoom(db, roomId, watcher, 'watching')
      expect(await participantStatus(db, roomId, watcher.humanId)).toMatchObject({
        role: 'moderator',
        status: 'active',
      })
      await db.rpc('room_end', { room_id: roomId }, watcher.as)
    })

    it('a moderator cannot eject the initiator by blocking them: the lower rank leaves', async () => {
      const host = await human(db, 'Rankhost')
      const mod = await human(db, 'Rankmod')
      await befriend(db, host, mod)
      const roomId = (await startStandaloneRoom(db, host)).room.id
      await joinRoom(db, roomId, mod, 'camera', 'friends')
      // The host steps out and back: `mod` was handed the room, the host returns as initiator.
      expect(
        RoomLeaveDtoSchema.parse(await db.rpc('room_leave', { room_id: roomId }, host.as))
          .transferredTo,
      ).toBe(mod.humanId)
      await joinRoom(db, roomId, host, 'camera', 'friends')
      expect(await participantStatus(db, roomId, host.humanId)).toMatchObject({
        role: 'initiator',
        status: 'active',
      })
      expect(await participantStatus(db, roomId, mod.humanId)).toMatchObject({
        role: 'moderator',
        status: 'active',
      })
      // room_remove_participant refuses a moderator removing the initiator …
      const hostSeat = participantId(await getRoom(db, roomId, mod.as), host.humanId)
      await db.expectError(
        db.rpc('room_remove_participant', { room_id: roomId, participant_id: hostSeat }, mod.as),
        'forbidden',
      )
      // … and a block must not be the back door.
      await db.rpc('block_set', { target_human_id: host.humanId, blocked: true }, mod.as)
      expect(await participantStatus(db, roomId, host.humanId)).toMatchObject({
        role: 'initiator',
        status: 'active',
      })
      expect(await participantStatus(db, roomId, mod.humanId)).toMatchObject({ status: 'left' })
      expect((await grant(db, roomId, host.as)).role).toBe('initiator')
      await db.expectError(db.rpc('room_get', { room_id: roomId }, mod.as), 'room_not_found')
      await db.rpc('room_end', { room_id: roomId }, host.as)
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('grace-period end', () => {
    it('is measured from the last active Human leaving and honours app_settings.room_grace_seconds', async () => {
      await setSetting(db, 'room_grace_seconds', '30')
      try {
        const host = await human(db, 'Ghost')
        const roomId = (await startStandaloneRoom(db, host)).room.id
        const invite = await createRoomInvite(db, roomId, host)
        await createGuestSession(db, await createGuest(db), invite.token, 'Sam')
        const leftAt = secondsFromNow(0)
        await rpcAt(db, 'room_leave', { room_id: roomId }, host.as, leftAt)
        const absentSince = await scalar<Date>(
          db,
          'humans_absent_since from public.rooms where id = $1',
          [roomId],
        )
        expect(Math.abs(absentSince.getTime() - new Date(leftAt).getTime())).toBeLessThan(1000)
        expect(
          (
            await rpcAt<{ roomsEnded: number }>(
              db,
              'rooms_sweep',
              {},
              'service',
              secondsFromNow(25),
            )
          ).roomsEnded,
        ).toBe(0)
        expect((await roomRow(db, roomId)).status).toBe('active')
        expect(
          (
            await rpcAt<{ roomsEnded: number }>(
              db,
              'rooms_sweep',
              {},
              'service',
              secondsFromNow(31),
            )
          ).roomsEnded,
        ).toBe(1)
        expect(await roomRow(db, roomId)).toMatchObject({
          status: 'ended',
          ended_reason: 'no_humans',
        })
        // The Guest session expires with the room plus its grace; the room is gone for the Guest afterwards.
        expect(
          await count(
            db,
            'public.guest_sessions',
            "room_id = $1 and expires_at <= now() + interval '11 minutes'",
            [roomId],
          ),
        ).toBe(1)
      } finally {
        await setSetting(db, 'room_grace_seconds', '120')
      }
    })

    it('waiting and invited Humans do not keep a room alive; only active Humans reset the clock', async () => {
      const host = await human(db, 'Whost2')
      const friend = await human(db, 'Wfriend2')
      const requester = await human(db, 'Wrequester2')
      await befriend(db, host, friend)
      // A direct room where the other member never takes their seat.
      const dm = await directConversation(db, host, friend)
      const direct = (
        await db.rpc<{ room: { id: string } }>(
          'room_start',
          { context_type: 'direct', context_id: dm },
          host.as,
        )
      ).room.id
      await db.rpc('room_leave', { room_id: direct }, host.as)
      expect(await roomRow(db, direct)).toMatchObject({
        active_human_count: 0,
        active_participant_count: 0,
      })
      expect((await db.rpc<{ roomsEnded: number }>('rooms_sweep', {}, 'service')).roomsEnded).toBe(
        1,
      )
      expect(await roomRow(db, direct)).toMatchObject({ status: 'ended', ended_reason: 'empty' })
      expect(await participantStatus(db, direct, friend.humanId)).toMatchObject({ status: 'left' })

      // A world room with a Guest and a waiting Human: the Guest holds it only for the grace.
      const roomId = (await startStandaloneRoom(db, host)).room.id
      await db.rpc(
        'room_set_visibility',
        { room_id: roomId, visibility: 'world', join_policy: 'request' },
        host.as,
      )
      const invite = await createRoomInvite(db, roomId, host)
      await createGuestSession(db, await createGuest(db), invite.token, 'Sam')
      expect((await joinRoom(db, roomId, requester, 'camera', 'world')).myParticipant?.status).toBe(
        'waiting',
      )
      await db.rpc('room_leave', { room_id: roomId }, host.as)
      expect(await roomRow(db, roomId)).toMatchObject({
        active_human_count: 0,
        active_participant_count: 1,
      })
      // The requester asking again within the grace does not reset anything.
      expect((await joinRoom(db, roomId, requester, 'camera', 'world')).myParticipant?.status).toBe(
        'waiting',
      )
      expect(
        (await rpcAt<{ roomsEnded: number }>(db, 'rooms_sweep', {}, 'service', secondsFromNow(60)))
          .roomsEnded,
      ).toBe(0)
      // A friend coming back to watch resets the clock and takes the room over.
      await rpcAt(
        db,
        'room_join',
        { room_id: roomId, media_state: 'watching', consent_level: 'invited' },
        friend.as,
        secondsFromNow(90),
      )
      expect(
        await scalar(db, 'humans_absent_since from public.rooms where id = $1', [roomId]),
      ).toBeNull()
      expect(
        (await rpcAt<{ roomsEnded: number }>(db, 'rooms_sweep', {}, 'service', secondsFromNow(300)))
          .roomsEnded,
      ).toBe(0)
      expect(await participantStatus(db, roomId, friend.humanId)).toMatchObject({
        role: 'moderator',
      })
      await rpcAt(db, 'room_leave', { room_id: roomId }, friend.as, secondsFromNow(100))
      expect(
        (await rpcAt<{ roomsEnded: number }>(db, 'rooms_sweep', {}, 'service', secondsFromNow(221)))
          .roomsEnded,
      ).toBe(1)
      expect(await roomRow(db, roomId)).toMatchObject({
        status: 'ended',
        ended_reason: 'no_humans',
      })
      expect(await participantStatus(db, roomId, requester.humanId)).toMatchObject({
        status: 'left',
      })
    })

    it('the sweep and the reconciler are service-only for every other caller kind', async () => {
      const guest = await createGuest(db)
      const claiming = await createHuman(db, {
        handle: nextHandle('sweepclaim'),
        status: 'pending',
      })
      const h = await human(db, 'Sweeper')
      for (const as of ['visitor', guest.as, claiming.as, h.as] as const) {
        expect(await sqlErrorCode(db.rpc('rooms_sweep', {}, as))).toBe(PERMISSION_DENIED)
        expect(
          await sqlErrorCode(
            db.rpc(
              'room_participant_sync',
              { room_id: randomUUID(), livekit_identity: 'h:x', event: 'room_finished' },
              as,
            ),
          ),
        ).toBe(PERMISSION_DENIED)
      }
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('the token grant never exceeds the seat', () => {
    let host: Human
    let group: GroupFixture
    let roomId: string

    beforeAll(async () => {
      host = await human(db, 'Thost')
      group = await createGroup(db, host, 'Token Crew')
      roomId = (await startGroupRoom(db, host, group)).room.id
      await db.rpc(
        'room_set_visibility',
        { room_id: roomId, visibility: 'world', join_policy: 'request' },
        host.as,
      )
    })

    afterAll(async () => {
      await db.rpc('room_end', { room_id: roomId }, host.as)
    })

    it('visitors, Guests of other rooms, claiming and unclaimed credentials, strangers, waiting and invited seats get no grant', async () => {
      await db.expectError(
        db.rpc('room_media_grant', { room_id: roomId }, 'visitor'),
        'not_authenticated',
      )
      await db.expectError(
        db.rpc('room_media_grant', { room_id: roomId }, (await createGuest(db)).as),
        'not_in_room',
      )
      const claiming = await createHuman(db, { handle: nextHandle('tokclaim'), status: 'pending' })
      await db.expectError(
        db.rpc('room_media_grant', { room_id: roomId }, claiming.as),
        'not_a_human',
      )
      await db.expectError(
        db.rpc('room_media_grant', { room_id: roomId }, (await createUnclaimed(db)).as),
        'not_a_human',
      )
      const stranger = await human(db, 'Tstranger')
      await db.expectError(
        db.rpc('room_media_grant', { room_id: roomId }, stranger.as),
        'not_in_room',
      )
      expect((await joinRoom(db, roomId, stranger, 'camera', 'world')).myParticipant?.status).toBe(
        'waiting',
      )
      await db.expectError(
        db.rpc('room_media_grant', { room_id: roomId }, stranger.as),
        'not_in_room',
      )
      // An invited seat in a direct room is not an active one.
      const other = await human(db, 'Tinvited')
      const dm = await directConversation(db, host, other)
      const direct = (
        await db.rpc<{ room: { id: string } }>(
          'room_start',
          { context_type: 'direct', context_id: dm },
          host.as,
        )
      ).room.id
      await db.expectError(db.rpc('room_media_grant', { room_id: direct }, other.as), 'not_in_room')
      await db.rpc('room_end', { room_id: direct }, host.as)
    })

    it('canPublish and role follow the seat exactly: viewer → publisher → viewer, transfer, removal, suspension, end', async () => {
      const member = await human(db, 'Tmember')
      await addMember(db, group, member)
      await joinRoom(db, roomId, member, 'watching')
      expect(await grant(db, roomId, member.as)).toMatchObject({
        role: 'viewer',
        canPublish: false,
        canSubscribe: true,
        identity: `h:${member.humanId}`,
      })
      await db.rpc(
        'room_set_media_state',
        { room_id: roomId, media_state: 'audio', consent_level: 'world' },
        member.as,
      )
      expect(await grant(db, roomId, member.as)).toMatchObject({
        role: 'participant',
        canPublish: true,
      })
      await db.rpc('room_set_media_state', { room_id: roomId, media_state: 'watching' }, member.as)
      expect(await grant(db, roomId, member.as)).toMatchObject({
        role: 'viewer',
        canPublish: false,
      })
      // Transfer shows in the grant; the initiator coming back is the initiator again.
      expect(
        RoomLeaveDtoSchema.parse(await db.rpc('room_leave', { room_id: roomId }, host.as))
          .transferredTo,
      ).toBe(member.humanId)
      expect(await grant(db, roomId, member.as)).toMatchObject({
        role: 'moderator',
        canPublish: false,
      })
      await db.expectError(db.rpc('room_media_grant', { room_id: roomId }, host.as), 'not_in_room')
      await joinRoom(db, roomId, host, 'camera', 'world')
      expect(await grant(db, roomId, host.as)).toMatchObject({
        role: 'initiator',
        canPublish: true,
      })
      // A Guest is always participant/viewer with a g: identity.
      const invite = await createRoomInvite(db, roomId, host)
      const guest = await createGuest(db)
      const session = await createGuestSession(db, guest, invite.token, 'Sam', {
        mediaState: 'watching',
      })
      expect(await grant(db, roomId, guest.as)).toMatchObject({
        role: 'viewer',
        canPublish: false,
        identity: `g:${session.guestSessionId}`,
        name: 'Sam',
      })
      await db.rpc('room_set_media_state', { room_id: roomId, media_state: 'camera' }, guest.as)
      expect(await grant(db, roomId, guest.as)).toMatchObject({
        role: 'participant',
        canPublish: true,
      })
      // Removal and suspension close the grant.
      const seat = participantId(await getRoom(db, roomId, host.as), member.humanId)
      await db.rpc('room_remove_participant', { room_id: roomId, participant_id: seat }, host.as)
      await db.expectError(
        db.rpc('room_media_grant', { room_id: roomId }, member.as),
        'not_in_room',
      )
      const suspended = await human(db, 'Tsuspended')
      await addMember(db, group, suspended)
      await joinRoom(db, roomId, suspended, 'camera', 'world')
      expect((await grant(db, roomId, suspended.as)).canPublish).toBe(true)
      await db.sql.query(`update public.humans set status = 'suspended' where id = $1`, [
        suspended.humanId,
      ])
      await db.expectError(
        db.rpc('room_media_grant', { room_id: roomId }, suspended.as),
        'human_not_active',
      )
      await db.sql.query(`update public.humans set status = 'active' where id = $1`, [
        suspended.humanId,
      ])
      await db.rpc('room_leave', { room_id: roomId }, suspended.as)
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('Guests cannot expand, invite, moderate, discover or DM', () => {
    let host: Human
    let cohost: Human
    let roomId: string
    let token: string
    let guest: Guest
    let dm: string

    beforeAll(async () => {
      host = await human(db, 'Ghost2')
      cohost = await human(db, 'Gcohost')
      await befriend(db, host, cohost)
      roomId = (await startStandaloneRoom(db, host, 'Guests')).room.id
      await joinRoom(db, roomId, cohost, 'camera', 'friends')
      token = (await createRoomInvite(db, roomId, host)).token
      guest = await createGuest(db)
      await createGuestSession(db, guest, token, 'Sam')
      dm = await directConversation(db, host, cohost)
    })

    afterAll(async () => {
      await db.rpc('room_end', { room_id: roomId }, host.as)
    })

    it('every moderator, invite and discovery affordance refuses the Guest', async () => {
      const cohostSeat = participantId(await getRoom(db, roomId, host.as), cohost.humanId)
      const calls: Array<[string, Record<string, unknown>, string]> = [
        ['room_set_visibility', { room_id: roomId, visibility: 'world' }, 'guest_not_allowed'],
        ['room_set_join_policy', { room_id: roomId, join_policy: 'anyone' }, 'guest_not_allowed'],
        ['room_set_guests_disabled', { room_id: roomId, disabled: false }, 'guest_not_allowed'],
        ['room_admit', { room_id: roomId, participant_id: cohostSeat }, 'guest_not_allowed'],
        [
          'room_remove_participant',
          { room_id: roomId, participant_id: cohostSeat },
          'guest_not_allowed',
        ],
        ['room_end', { room_id: roomId }, 'guest_not_allowed'],
        ['room_invite_create', { room_id: roomId }, 'guest_not_allowed'],
        ['room_consent', { room_id: roomId, level: 'world' }, 'guest_not_allowed'],
        ['live_candidates', { scope: 'world' }, 'guest_not_allowed'],
        [
          'room_invite_join',
          { token, media_state: 'camera', consent_level: 'world' },
          'not_a_human',
        ],
        ['room_start', { context_type: 'standalone' }, 'not_a_human'],
      ]
      for (const [name, args, code] of calls) {
        expect(await errorCode(db.rpc(name, args, guest.as)), name).toBe(code)
      }
      // The room is untouched.
      expect(await roomRow(db, roomId)).toMatchObject({
        visibility: 'friends',
        join_policy: 'friends',
        status: 'active',
      })
      expect(await count(db, 'public.room_invites', 'room_id = $1', [roomId])).toBe(1)
    })

    it('a Guest cannot DM, friend, follow or read conversations of the Humans they met', async () => {
      const calls: Array<[string, Record<string, unknown>]> = [
        ['conversation_direct_get_or_create', { other_human_id: host.humanId }],
        [
          'message_send',
          { conversation_id: dm, client_id: randomUUID(), type: 'text', text: 'hi from a guest' },
        ],
        ['friend_request_send', { target_human_id: host.humanId }],
        ['follow_set', { target_human_id: host.humanId, following: true }],
        ['presence_ping', { conversation_id: null, room_id: roomId, platform: 'web' }],
      ]
      for (const [name, args] of calls) {
        expect(await errorCode(db.rpc(name, args, guest.as)), name).toBe('not_a_human')
      }
      expect(await count(db, 'public.messages', 'conversation_id = $1', [dm])).toBe(0)
      expect(await count(db, 'public.relationships', 'source_human_id is null')).toBe(0)
      for (const table of [
        'conversations',
        'conversation_members',
        'messages',
        'relationships',
        'blocks',
      ]) {
        const rows = await rowsAs(db, guest.as, `select * from public.${table}`).catch(
          (error: unknown) => {
            if (error instanceof pg.DatabaseError && error.code === PERMISSION_DENIED) return []
            throw error
          },
        )
        expect(rows, table).toEqual([])
      }
    })

    it('a Guest exists in exactly one room: no other room is readable, joinable or grantable', async () => {
      const other = (await startStandaloneRoom(db, host, 'Other')).room.id
      await db.rpc('room_set_visibility', { room_id: other, visibility: 'world' }, host.as)
      await db.expectError(db.rpc('room_get', { room_id: other }, guest.as), 'room_not_found')
      await db.expectError(
        db.rpc('room_join', { room_id: other, media_state: 'audio' }, guest.as),
        'guest_not_allowed',
      )
      await db.expectError(db.rpc('room_media_grant', { room_id: other }, guest.as), 'not_in_room')
      await db.expectError(
        db.rpc('room_set_media_state', { room_id: other, media_state: 'camera' }, guest.as),
        'not_in_room',
      )
      expect(await rowsAs(db, guest.as, 'select id from public.rooms')).toEqual([{ id: roomId }])
      await db.rpc('room_end', { room_id: other }, host.as)
    })

    it('"guests disabled" is temporary: re-enabling lets the same Guest credential come back; a moderator removal does not', async () => {
      const kicked = await createGuest(db)
      await createGuestSession(db, kicked, token, 'Pat')
      await db.rpc('room_set_guests_disabled', { room_id: roomId, disabled: true }, host.as)
      await db.expectError(db.rpc('room_media_grant', { room_id: roomId }, guest.as), 'not_in_room')
      await db.expectError(
        db.rpc('room_join', { room_id: roomId, media_state: 'audio' }, guest.as),
        'guests_disabled',
      )
      await db.expectError(
        db.rpc('guest_session_create', { token, display_name: 'Sam' }, guest.as),
        'guests_disabled',
      )
      await db.rpc('room_set_guests_disabled', { room_id: roomId, disabled: false }, host.as)
      // Not blocked: the Guest was never removed by a person.
      const back = RoomDtoSchema.parse(
        await db
          .rpc('room_join', { room_id: roomId, media_state: 'audio' }, guest.as)
          .catch(async () => {
            await createGuestSession(db, guest, token, 'Sam')
            return db.rpc('room_get', { room_id: roomId }, guest.as)
          }),
      )
      expect(back.myParticipant).toMatchObject({ status: 'active', isGuest: true })
      await createGuestSession(db, kicked, token, 'Pat')
      expect(
        (await getRoom(db, roomId, host.as)).participants.filter((p) => p.isGuest),
      ).toHaveLength(2)
      // A removal by a moderator is final for that credential.
      const patSeat = (await getRoom(db, roomId, host.as)).participants.find(
        (p) => p.displayName === 'Pat',
      )?.id
      await db.rpc('room_remove_participant', { room_id: roomId, participant_id: patSeat }, host.as)
      await db.expectError(
        db.rpc('guest_session_create', { token, display_name: 'Pat' }, kicked.as),
        'blocked',
      )
      await db.expectError(
        db.rpc('room_join', { room_id: roomId, media_state: 'audio' }, kicked.as),
        'guest_not_allowed',
      )
    })

    it('GUEST_ROOMS_ENABLED is a kill switch: Guests already inside stop joining and minting grants', async () => {
      const inside = await createGuest(db)
      await createGuestSession(db, inside, token, 'Kim')
      expect((await grant(db, roomId, inside.as)).canPublish).toBe(true)
      await setFlag(db, 'GUEST_ROOMS_ENABLED', false)
      try {
        await db.expectError(
          db.rpc(
            'guest_session_create',
            { token, display_name: 'Sam' },
            (await createGuest(db)).as,
          ),
          'feature_disabled',
        )
        await db.expectError(
          db.rpc('room_media_grant', { room_id: roomId }, inside.as),
          'feature_disabled',
        )
        await db.rpc('room_leave', { room_id: roomId }, inside.as)
        await db.expectError(
          db.rpc('room_join', { room_id: roomId, media_state: 'audio' }, inside.as),
          'feature_disabled',
        )
        expect(
          (
            await sync(
              db,
              roomId,
              `g:${await scalar<string>(db, 'id from public.guest_sessions where auth_user_id = $1', [inside.userId])}`,
              'participant_joined',
              secondsFromNow(1),
            )
          ).applied,
        ).toBe(false)
        // Reading the room they were in and leaving still work; a Human is unaffected.
        expect((await getRoom(db, roomId, inside.as)).id).toBe(roomId)
        expect((await grant(db, roomId, host.as)).canPublish).toBe(true)
      } finally {
        await setFlag(db, 'GUEST_ROOMS_ENABLED', true)
      }
      expect(
        RoomDtoSchema.parse(
          await db.rpc('room_join', { room_id: roomId, media_state: 'audio' }, inside.as),
        ).myParticipant?.status,
      ).toBe('active')
      expect((await grant(db, roomId, inside.as)).canPublish).toBe(true)
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('join policy is enforced on the first publish, not only on the first entry', () => {
    it('watch first, then camera: invited_only still refuses; request queues; admission and links persist; toggling never re-asks', async () => {
      const host = await human(db, 'Phost')
      const stranger = await human(db, 'Pstranger')
      const linker = await human(db, 'Plinker')
      const returning = await human(db, 'Preturning')
      const roomId = (await startStandaloneRoom(db, host)).room.id
      await db.rpc(
        'room_set_visibility',
        { room_id: roomId, visibility: 'world', join_policy: 'invited_only' },
        host.as,
      )

      // A stranger may watch a world room; watching is not an invitation to publish.
      expect((await joinRoom(db, roomId, stranger, 'watching')).myParticipant?.status).toBe(
        'active',
      )
      await db.expectError(
        db.rpc(
          'room_join',
          { room_id: roomId, media_state: 'camera', consent_level: 'world' },
          stranger.as,
        ),
        'join_not_allowed',
      )
      await db.expectError(
        db.rpc(
          'room_set_media_state',
          { room_id: roomId, media_state: 'camera', consent_level: 'world' },
          stranger.as,
        ),
        'join_not_allowed',
      )
      await db.expectError(
        db.rpc(
          'room_set_media_state',
          { room_id: roomId, media_state: 'audio', consent_level: 'world' },
          stranger.as,
        ),
        'join_not_allowed',
      )
      expect(await participantStatus(db, roomId, stranger.humanId)).toMatchObject({
        status: 'active',
        media_state: 'watching',
        role: 'viewer',
      })
      expect((await grant(db, roomId, stranger.as)).canPublish).toBe(false)
      expect(await publishersSeenBy(db, roomId, 'visitor')).toEqual(['Phost'])

      // Under `request`, the upgrade is a request: the seat waits until a moderator admits it.
      await db.rpc('room_set_join_policy', { room_id: roomId, join_policy: 'request' }, host.as)
      await db.rpc(
        'room_set_media_state',
        { room_id: roomId, media_state: 'camera', consent_level: 'world' },
        stranger.as,
      )
      expect(await participantStatus(db, roomId, stranger.humanId)).toMatchObject({
        status: 'waiting',
      })
      await db.expectError(
        db.rpc('room_media_grant', { room_id: roomId }, stranger.as),
        'not_in_room',
      )
      expect(await publishersSeenBy(db, roomId, 'visitor')).toEqual(['Phost'])
      const seat = (await getRoom(db, roomId, host.as)).participants.find(
        (p) => p.humanId === stranger.humanId,
      )?.id
      await db.rpc('room_admit', { room_id: roomId, participant_id: seat }, host.as)
      expect(await participantStatus(db, roomId, stranger.humanId)).toMatchObject({
        status: 'active',
        media_state: 'camera',
      })
      expect((await grant(db, roomId, stranger.as)).canPublish).toBe(true)
      // Admission persists across toggles and a stricter policy: no second request.
      await db.rpc(
        'room_set_join_policy',
        { room_id: roomId, join_policy: 'invited_only' },
        host.as,
      )
      await db.rpc(
        'room_set_media_state',
        { room_id: roomId, media_state: 'watching' },
        stranger.as,
      )
      await db.rpc('room_set_media_state', { room_id: roomId, media_state: 'camera' }, stranger.as)
      expect(await participantStatus(db, roomId, stranger.humanId)).toMatchObject({
        status: 'active',
        media_state: 'camera',
      })

      // A link is an invitation, watching first or not.
      const invite = await createRoomInvite(db, roomId, host)
      expect(
        RoomDtoSchema.parse(
          await db.rpc(
            'room_invite_join',
            { token: invite.token, media_state: 'watching' },
            linker.as,
          ),
        ).myParticipant?.status,
      ).toBe('active')
      await db.rpc(
        'room_set_media_state',
        { room_id: roomId, media_state: 'camera', consent_level: 'world' },
        linker.as,
      )
      expect((await grant(db, roomId, linker.as)).canPublish).toBe(true)

      // A publisher who left comes back on camera without re-passing the policy (reconnects).
      expect(
        RoomDtoSchema.parse(
          await db.rpc(
            'room_invite_join',
            { token: invite.token, media_state: 'camera', consent_level: 'world' },
            returning.as,
          ),
        ).myParticipant?.status,
      ).toBe('active')
      await db.rpc('room_leave', { room_id: roomId }, returning.as)
      expect((await joinRoom(db, roomId, returning, 'camera', 'world')).myParticipant?.status).toBe(
        'active',
      )
      // A watcher who left gained nothing by having watched.
      const watcher = await human(db, 'Pwatcher')
      await joinRoom(db, roomId, watcher, 'watching')
      await db.rpc('room_leave', { room_id: roomId }, watcher.as)
      await db.expectError(
        db.rpc(
          'room_join',
          { room_id: roomId, media_state: 'camera', consent_level: 'world' },
          watcher.as,
        ),
        'join_not_allowed',
      )
      await db.rpc('room_end', { room_id: roomId }, host.as)
    })

    it('a group member or friend upgrading from a watching seat passes the policy on their own merits', async () => {
      const owner = await human(db, 'Uowner')
      const member = await human(db, 'Umember')
      const friend = await human(db, 'Ufriend')
      const group = await createGroup(db, owner, 'Upgrade Crew')
      await addMember(db, group, member)
      await befriend(db, owner, friend)
      const roomId = (await startGroupRoom(db, owner, group)).room.id
      await db.rpc(
        'room_set_visibility',
        { room_id: roomId, visibility: 'friends', join_policy: 'group' },
        owner.as,
      )
      await joinRoom(db, roomId, member, 'watching')
      await joinRoom(db, roomId, friend, 'watching')
      await db.rpc(
        'room_set_media_state',
        { room_id: roomId, media_state: 'camera', consent_level: 'friends' },
        member.as,
      )
      expect(await participantStatus(db, roomId, member.humanId)).toMatchObject({
        media_state: 'camera',
        status: 'active',
      })
      await db.expectError(
        db.rpc(
          'room_set_media_state',
          { room_id: roomId, media_state: 'camera', consent_level: 'friends' },
          friend.as,
        ),
        'join_not_allowed',
      )
      await db.rpc('room_set_join_policy', { room_id: roomId, join_policy: 'friends' }, owner.as)
      await db.rpc(
        'room_set_media_state',
        { room_id: roomId, media_state: 'camera', consent_level: 'friends' },
        friend.as,
      )
      expect(await participantStatus(db, roomId, friend.humanId)).toMatchObject({
        media_state: 'camera',
        status: 'active',
      })
      await db.rpc('room_end', { room_id: roomId }, owner.as)
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('join policy × visibility pairs', () => {
    let city: string
    let neighborhood: string

    beforeAll(async () => {
      city = await createArea(db, { name: 'Pair City', slug: 'pair-city', type: 'city' })
      neighborhood = await createArea(db, {
        name: 'Pair Hood',
        slug: 'pair-hood',
        type: 'neighborhood',
        parentAreaId: city,
      })
    })

    /** What the database must answer for `room_set_visibility(v, p)` on a solo room of `contextType`. */
    function expectedPair(
      contextType: 'group' | 'standalone',
      v: RoomVisibility,
      p: RoomJoinPolicy,
    ): string | null {
      if (
        (v === 'invited' && contextType === 'group') ||
        (v === 'group' && contextType !== 'group')
      )
        return 'visibility_not_allowed'
      if (!isJoinPolicyAllowedFor(v, p, contextType)) return 'invalid_input'
      return null
    }

    for (const contextType of ['standalone', 'group'] as const) {
      it(`room_set_visibility on a ${contextType} room accepts exactly the pairs the domain offers`, async () => {
        const host = await human(db, `Pair${contextType}`)
        await setContext(db, host, { currentAreaId: neighborhood, currentCityId: city })
        const roomId =
          contextType === 'group'
            ? (await startGroupRoom(db, host, await createGroup(db, host, 'Pair Crew'))).room.id
            : (await startStandaloneRoom(db, host)).room.id
        for (const v of ROOM_VISIBILITY) {
          for (const p of ROOM_JOIN_POLICY) {
            const expected = expectedPair(contextType, v, p)
            const code = await errorCode(
              db.rpc(
                'room_set_visibility',
                { room_id: roomId, visibility: v, join_policy: p },
                host.as,
              ),
            )
            expect(code, `${contextType} ${v}/${p}`).toBe(expected)
            if (expected === null) {
              expect(await roomRow(db, roomId), `${contextType} ${v}/${p} applied`).toMatchObject({
                visibility: v,
                join_policy: p,
                pending_visibility: null,
              })
            }
          }
        }
        await db.rpc('room_end', { room_id: roomId }, host.as)
      })

      it(`room_set_join_policy on a ${contextType} room accepts exactly allowedJoinPoliciesFor(visibility, contextType)`, async () => {
        const host = await human(db, `Pol${contextType}`)
        await setContext(db, host, { currentAreaId: neighborhood, currentCityId: city })
        const roomId =
          contextType === 'group'
            ? (await startGroupRoom(db, host, await createGroup(db, host, 'Policy Crew'))).room.id
            : (await startStandaloneRoom(db, host)).room.id
        for (const v of ROOM_VISIBILITY) {
          if (expectedPair(contextType, v, allowedJoinPoliciesFor(v, contextType)[0]!) !== null)
            continue
          await db.rpc('room_set_visibility', { room_id: roomId, visibility: v }, host.as)
          for (const p of ROOM_JOIN_POLICY) {
            const code = await errorCode(
              db.rpc('room_set_join_policy', { room_id: roomId, join_policy: p }, host.as),
            )
            expect(code, `${contextType} ${v} → ${p}`).toBe(
              isJoinPolicyAllowedFor(v, p, contextType) ? null : 'invalid_input',
            )
          }
          expect((await roomRow(db, roomId)).visibility).toBe(v)
        }
        await db.rpc('room_end', { room_id: roomId }, host.as)
      })
    }

    it('an invite override is a moderator affordance and must be offered for the visibility (or be the link policy)', async () => {
      const host = await human(db, 'Ovhost')
      const friend = await human(db, 'Ovfriend')
      await befriend(db, host, friend)
      const roomId = (await startStandaloneRoom(db, host)).room.id
      await joinRoom(db, roomId, friend, 'camera', 'friends')
      await db.expectError(
        db.rpc(
          'room_invite_create',
          { room_id: roomId, join_policy_override: 'anyone_with_link' },
          friend.as,
        ),
        'not_a_moderator',
      )
      await db.expectError(
        db.rpc('room_invite_create', { room_id: roomId, join_policy_override: 'group' }, host.as),
        'invalid_input',
      )
      await db.expectError(
        db.rpc('room_invite_create', { room_id: roomId, join_policy_override: 'anyone' }, host.as),
        'invalid_input',
      )
      await db.rpc(
        'room_invite_create',
        { room_id: roomId, join_policy_override: 'anyone_with_link' },
        host.as,
      )
      await db.rpc(
        'room_invite_create',
        { room_id: roomId, join_policy_override: 'request' },
        host.as,
      )
      expect(await count(db, 'public.room_invites', 'room_id = $1', [roomId])).toBe(2)
      await db.rpc('room_end', { room_id: roomId }, host.as)
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('feature flags', () => {
    let city: string

    beforeAll(async () => {
      city = await createArea(db, { name: 'Flag City', slug: 'flag-city', type: 'city' })
    })

    it('FRIENDS_LIVE_EXPANSION_ENABLED gates standalone rooms and every widening to friends or extended; narrowing never', async () => {
      const owner = await human(db, 'Fowner')
      const group = await createGroup(db, owner, 'Flag Crew')
      const roomId = (await startGroupRoom(db, owner, group)).room.id
      await db.rpc('room_set_visibility', { room_id: roomId, visibility: 'extended' }, owner.as)
      await setFlag(db, 'FRIENDS_LIVE_EXPANSION_ENABLED', false)
      try {
        await db.expectError(
          db.rpc('room_start', { context_type: 'standalone' }, owner.as),
          'feature_disabled',
        )
        expect(
          RoomVisibilityChangeDtoSchema.parse(
            await db.rpc('room_set_visibility', { room_id: roomId, visibility: 'group' }, owner.as),
          ).applied,
        ).toBe(true)
        await db.expectError(
          db.rpc('room_set_visibility', { room_id: roomId, visibility: 'friends' }, owner.as),
          'feature_disabled',
        )
        await db.expectError(
          db.rpc('room_set_visibility', { room_id: roomId, visibility: 'extended' }, owner.as),
          'feature_disabled',
        )
        await db.expectError(
          db.rpc('room_set_visibility', { room_id: roomId, visibility: 'world' }, owner.as),
          'feature_disabled',
        )
      } finally {
        await setFlag(db, 'FRIENDS_LIVE_EXPANSION_ENABLED', true)
      }
      await db.rpc('room_end', { room_id: roomId }, owner.as)
    })

    it('a widening that was pending when its flag went off never applies', async () => {
      const owner = await human(db, 'Pfowner')
      const member = await human(db, 'Pfmember')
      const friend = await human(db, 'Pffriend')
      await befriend(db, owner, friend)
      const group = await createGroup(db, owner, 'Pending Flag Crew')
      await addMember(db, group, member)
      const roomId = (await startGroupRoom(db, owner, group)).room.id
      await joinRoom(db, roomId, member, 'camera', 'group')
      expect(
        RoomVisibilityChangeDtoSchema.parse(
          await db.rpc('room_set_visibility', { room_id: roomId, visibility: 'friends' }, owner.as),
        ).applied,
      ).toBe(false)
      await setFlag(db, 'FRIENDS_LIVE_EXPANSION_ENABLED', false)
      try {
        const consent = RoomVisibilityChangeDtoSchema.parse(
          await db.rpc('room_consent', { room_id: roomId, level: 'friends' }, member.as),
        )
        expect(consent.applied).toBe(false)
        expect(await roomRow(db, roomId)).toMatchObject({ visibility: 'group' })
        expect(await liveIds(db, 'friends', friend.as)).not.toContain(roomId)
        await db.expectError(db.rpc('room_get', { room_id: roomId }, friend.as), 'room_not_found')
        // Every other evaluation path stays closed too.
        await db.rpc(
          'room_set_media_state',
          { room_id: roomId, media_state: 'watching' },
          member.as,
        )
        await db.rpc('room_leave', { room_id: roomId }, member.as)
        expect(await roomRow(db, roomId)).toMatchObject({ visibility: 'group' })
      } finally {
        await setFlag(db, 'FRIENDS_LIVE_EXPANSION_ENABLED', true)
      }
      // Once the flag is back the moderator asks again; nothing is applied behind their back.
      expect(await roomRow(db, roomId)).toMatchObject({ visibility: 'group' })
      expect(
        RoomVisibilityChangeDtoSchema.parse(
          await db.rpc('room_set_visibility', { room_id: roomId, visibility: 'friends' }, owner.as),
        ).applied,
      ).toBe(true)
      await db.rpc('room_end', { room_id: roomId }, owner.as)
    })

    it('WORLD_LIVE_EXPANSION_ENABLED and PUBLIC_LIVE_ENABLED gate neighborhood/city/world, and PUBLIC_LIVE_ENABLED gates visitors', async () => {
      const host = await human(db, 'Wfhost')
      await setContext(db, host, { currentCityId: city })
      const roomId = (await startStandaloneRoom(db, host)).room.id
      for (const flag of ['WORLD_LIVE_EXPANSION_ENABLED', 'PUBLIC_LIVE_ENABLED'] as const) {
        await setFlag(db, flag, false)
        try {
          for (const v of ['neighborhood', 'city', 'world'] as const) {
            await db.expectError(
              db.rpc('room_set_visibility', { room_id: roomId, visibility: v }, host.as),
              'feature_disabled',
            )
          }
          expect(
            RoomVisibilityChangeDtoSchema.parse(
              await db.rpc(
                'room_set_visibility',
                { room_id: roomId, visibility: 'extended' },
                host.as,
              ),
            ).applied,
          ).toBe(true)
        } finally {
          await setFlag(db, flag, true)
        }
      }
      expect(
        RoomVisibilityChangeDtoSchema.parse(
          await db.rpc('room_set_visibility', { room_id: roomId, visibility: 'world' }, host.as),
        ).applied,
      ).toBe(true)
      expect(await liveIds(db, 'world', 'visitor')).toContain(roomId)
      const stranger = await human(db, 'Wfstranger')
      await setFlag(db, 'PUBLIC_LIVE_ENABLED', false)
      try {
        await db.expectError(
          db.rpc('live_candidates', { scope: 'world' }, 'visitor'),
          'feature_disabled',
        )
        await db.expectError(db.rpc('room_get', { room_id: roomId }, 'visitor'), 'room_not_found')
        expect(
          await rowsAs(db, 'visitor', 'select id from public.rooms where id = $1', [roomId]),
        ).toEqual([])
        expect(await liveIds(db, 'world', stranger.as)).toContain(roomId)
      } finally {
        await setFlag(db, 'PUBLIC_LIVE_ENABLED', true)
      }
      await db.rpc('room_end', { room_id: roomId }, host.as)
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('blocks and group membership hold inside live rooms', () => {
    it('the reconciler never re-seats a Human next to someone who blocked them since they left', async () => {
      const host = await human(db, 'Bhost')
      const friend = await human(db, 'Bfriend')
      await befriend(db, host, friend)
      const roomId = (await startStandaloneRoom(db, host)).room.id
      await joinRoom(db, roomId, friend, 'camera', 'friends')
      await db.rpc('room_leave', { room_id: roomId }, friend.as)
      await block(db, host, friend)
      const rejoin = await sync(
        db,
        roomId,
        `h:${friend.humanId}`,
        'participant_joined',
        secondsFromNow(1),
      )
      expect(rejoin.applied).toBe(false)
      expect(await participantStatus(db, roomId, friend.humanId)).toMatchObject({ status: 'left' })
      expect((await roomRow(db, roomId)).active_participant_count).toBe(1)
      await db.expectError(db.rpc('room_get', { room_id: roomId }, friend.as), 'room_not_found')
      await db.expectError(
        db.rpc('room_media_grant', { room_id: roomId }, friend.as),
        'not_in_room',
      )
      await db.rpc('room_end', { room_id: roomId }, host.as)
    })

    it('leaving or being removed from the group ends the seat in the group room and every former-seat privilege', async () => {
      const owner = await human(db, 'Gowner3')
      const removed = await human(db, 'Gremoved')
      const leaver = await human(db, 'Gleaver')
      const group = await createGroup(db, owner, 'Membership Crew')
      await addMember(db, group, removed)
      await addMember(db, group, leaver)
      const roomId = (await startGroupRoom(db, owner, group)).room.id
      await joinRoom(db, roomId, removed, 'camera', 'group')
      await joinRoom(db, roomId, leaver, 'camera', 'group')

      await db.rpc(
        'group_member_remove',
        { group_id: group.groupId, human_id: removed.humanId },
        owner.as,
      )
      await db.rpc('group_leave', { group_id: group.groupId }, leaver.as)
      for (const gone of [removed, leaver]) {
        expect((await participantStatus(db, roomId, gone.humanId))?.status).not.toBe('active')
        await db.expectError(
          db.rpc('room_media_grant', { room_id: roomId }, gone.as),
          'not_in_room',
        )
        await db.expectError(db.rpc('room_get', { room_id: roomId }, gone.as), 'room_not_found')
        await db.expectError(
          db.rpc('room_join', { room_id: roomId, media_state: 'watching' }, gone.as),
          'room_not_found',
        )
        await db.expectError(
          db.rpc('room_start', { context_type: 'group', context_id: group.groupId }, gone.as),
          'not_a_member',
        )
        expect(
          await rowsAs(db, gone.as, 'select id from public.rooms where id = $1', [roomId]),
        ).toEqual([])
      }
      expect((await getRoom(db, roomId, owner.as)).participants.map((p) => p.displayName)).toEqual([
        'Gowner3',
      ])
      expect(await roomRow(db, roomId)).toMatchObject({
        active_participant_count: 1,
        active_human_count: 1,
      })
      // Re-added, the seat can be taken again.
      await addMember(db, group, leaver)
      expect((await joinRoom(db, roomId, leaver, 'camera', 'group')).myParticipant?.status).toBe(
        'active',
      )
      await db.rpc('room_end', { room_id: roomId }, owner.as)
    })
  })
})
