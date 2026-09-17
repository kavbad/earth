/**
 * Shared fixtures for the rooms / guests / Live database tests (Milestones 3–4). Everything goes
 * through the RPCs of 0330 except where a raw row is the fastest way to set up a scenario
 * (relationships, areas, context). Re-exports the admission fixtures the room tests build on.
 */
import {
  GuestSessionDtoSchema,
  RoomDtoSchema,
  RoomInviteCreateDtoSchema,
  RoomStartDtoSchema,
  type GuestSessionDto,
  type RoomDto,
  type RoomStartDto,
} from '@earth/domain'

import { unwrapRpcResult, type RoleSpec, type TestDb } from '../harness'
import { createHuman, type GroupFixture, type Human } from '../admission/fixtures'

export {
  addMember,
  befriend,
  block,
  count,
  createArea,
  createGroup,
  createGuest,
  createHuman,
  createUnclaimed,
  notificationsFor,
  relate,
  scalar,
  setFlag,
  setSetting,
  type GroupFixture,
  type Human,
} from '../admission/fixtures'

export const NIL_UUID = '00000000-0000-0000-0000-000000000000'

export interface Guest {
  userId: string
  as: RoleSpec
}

/** Calls an RPC with the database clock frozen at `at` (earth.utc_now honours `earth.now`). */
export async function rpcAt<T = unknown>(
  db: TestDb,
  name: string,
  args: Record<string, unknown>,
  as: RoleSpec,
  at: string,
): Promise<T> {
  const keys = Object.keys(args)
  const placeholders = keys.map((key, i) => `"${key}" => $${i + 1}`).join(', ')
  return db.asRole(as, async (client) => {
    await client.query(`select set_config('earth.now', $1, true)`, [at])
    const result = await client.query(
      `select * from public."${name}"(${placeholders})`,
      keys.map((k) => args[k]),
    )
    return unwrapRpcResult(result) as T
  })
}

/** ISO timestamp `seconds` after now (server clock, taken once per call). */
export function secondsFromNow(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString()
}

export async function startGroupRoom(
  db: TestDb,
  initiator: Human,
  group: GroupFixture,
  title: string | null = null,
): Promise<RoomStartDto> {
  return RoomStartDtoSchema.parse(
    await db.rpc(
      'room_start',
      { context_type: 'group', context_id: group.groupId, title },
      initiator.as,
    ),
  )
}

export async function startStandaloneRoom(
  db: TestDb,
  initiator: Human,
  title: string | null = null,
): Promise<RoomStartDto> {
  return RoomStartDtoSchema.parse(
    await db.rpc(
      'room_start',
      { context_type: 'standalone', context_id: null, title },
      initiator.as,
    ),
  )
}

export async function directConversation(db: TestDb, a: Human, b: Human): Promise<string> {
  const conversation = await db.rpc<{ id: string }>(
    'conversation_direct_get_or_create',
    { other_human_id: b.humanId },
    a.as,
  )
  return conversation.id
}

export async function joinRoom(
  db: TestDb,
  roomId: string,
  human: Human,
  mediaState: 'watching' | 'audio' | 'camera' = 'watching',
  consentLevel = 'invited',
): Promise<RoomDto> {
  return RoomDtoSchema.parse(
    await db.rpc(
      'room_join',
      { room_id: roomId, media_state: mediaState, consent_level: consentLevel },
      human.as,
    ),
  )
}

export async function getRoom(db: TestDb, roomId: string, as: RoleSpec): Promise<RoomDto> {
  return RoomDtoSchema.parse(await db.rpc('room_get', { room_id: roomId }, as))
}

export async function createRoomInvite(
  db: TestDb,
  roomId: string,
  creator: Human,
  options: { expiresInSeconds?: number | null; joinPolicyOverride?: string | null } = {},
): Promise<{ token: string; url: string; expiresAt: string }> {
  return RoomInviteCreateDtoSchema.parse(
    await db.rpc(
      'room_invite_create',
      {
        room_id: roomId,
        expires_in_seconds: options.expiresInSeconds ?? null,
        join_policy_override: options.joinPolicyOverride ?? null,
      },
      creator.as,
    ),
  )
}

export async function createGuestSession(
  db: TestDb,
  guest: Guest,
  token: string,
  displayName = 'Sam',
  options: { fingerprint?: string | null; mediaState?: 'watching' | 'audio' | 'camera' } = {},
): Promise<GuestSessionDto & { sessionSecret: string }> {
  const raw = await db.rpc<Record<string, unknown>>(
    'guest_session_create',
    {
      token,
      display_name: displayName,
      device_fingerprint_hash: options.fingerprint ?? null,
      media_state: options.mediaState ?? 'audio',
    },
    guest.as,
  )
  const dto = GuestSessionDtoSchema.parse(raw)
  const secret = raw['sessionSecret']
  if (typeof secret !== 'string' || secret.length === 0) throw new Error('sessionSecret missing')
  return { ...dto, sessionSecret: secret }
}

/** The caller's participant row id for a room (from the DTO). */
export function participantId(room: RoomDto, humanId: string): string {
  const participant = room.participants.find((p) => p.humanId === humanId)
  if (participant === undefined) throw new Error(`no participant for ${humanId}`)
  return participant.id
}

export async function participantStatus(
  db: TestDb,
  roomId: string,
  humanId: string,
): Promise<{ status: string; role: string; media_state: string; consent: string } | null> {
  const { rows } = await db.sql.query<{
    status: string
    role: string
    media_state: string
    consent: string
  }>(
    `select status::text, role::text, media_state::text, audience_consent_level::text as consent
       from public.room_participants where room_id = $1 and human_id = $2
      order by joined_at desc limit 1`,
    [roomId, humanId],
  )
  return rows[0] ?? null
}

export async function roomRow(
  db: TestDb,
  roomId: string,
): Promise<{
  status: string
  visibility: string
  join_policy: string
  pending_visibility: string | null
  active_human_count: number
  active_participant_count: number
  ended_reason: string | null
  area_id: string | null
  area_precision: string
}> {
  const { rows } = await db.sql.query(
    `select status::text, visibility::text, join_policy::text, pending_visibility::text,
            active_human_count, active_participant_count, ended_reason, area_id, area_precision::text
       from public.rooms where id = $1`,
    [roomId],
  )
  const row = rows[0]
  if (row === undefined) throw new Error('room missing')
  return row as Awaited<ReturnType<typeof roomRow>>
}

export async function setContext(
  db: TestDb,
  human: Human,
  context: {
    currentAreaId?: string | null
    currentCityId?: string | null
    homeCityId?: string | null
  },
): Promise<void> {
  await db.sql.query(
    `insert into public.human_context (human_id, current_area_id, current_city_id, home_city_id)
     values ($1, $2, $3, $4)
     on conflict (human_id) do update
       set current_area_id = excluded.current_area_id,
           current_city_id = excluded.current_city_id,
           home_city_id = excluded.home_city_id`,
    [
      human.humanId,
      context.currentAreaId ?? null,
      context.currentCityId ?? null,
      context.homeCityId ?? null,
    ],
  )
}

export async function setConversationPrefs(
  db: TestDb,
  conversationId: string,
  human: Human,
  prefs: { muteState?: 'none' | 'muted'; notificationLevel?: 'all' | 'mentions' | 'none' },
): Promise<void> {
  await db.sql.query(
    `update public.conversation_members
        set mute_state = coalesce($3, mute_state), notification_level = coalesce($4, notification_level)
      where conversation_id = $1 and human_id = $2`,
    [conversationId, human.humanId, prefs.muteState ?? null, prefs.notificationLevel ?? null],
  )
}

let handleCounter = 0
/** A fresh active Human with a unique handle prefix. */
export async function human(db: TestDb, name: string): Promise<Human> {
  handleCounter += 1
  return createHuman(db, {
    handle: `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}${handleCounter}`,
    displayName: name,
  })
}
