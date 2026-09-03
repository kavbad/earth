import { asRoomId } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { RPC } from './rpc'
import { earthRejection } from './testing/expect'
import { postgrestRaise } from './testing/fake-supabase'
import * as fixtures from './testing/fixtures'
import { createTestClient } from './testing/harness'

const { IDS } = fixtures
const ROOM = asRoomId(IDS.room)

describe('rooms', () => {
  it('start maps to room_start(context_type, context_id, title)', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.roomStart, fixtures.roomStart())
    const started = await client.rooms.start({ contextType: 'group', contextId: IDS.group })
    expect(supabase.lastRpc()).toEqual({
      name: 'room_start',
      args: { context_type: 'group', context_id: IDS.group, title: null },
    })
    expect(started.created).toBe(true)
    await client.rooms.start({
      contextType: 'standalone',
      contextId: null,
      title: 'Cooking dinner',
    })
    expect(supabase.lastRpc().args).toEqual({
      context_type: 'standalone',
      context_id: null,
      title: 'Cooking dinner',
    })
    expect(
      (await earthRejection(client.rooms.start({ contextType: 'group', contextId: null }))).code,
    ).toBe('invalid_input')
  })

  it('get, join and joinWithInvite return RoomDto', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.roomGet, fixtures.roomDto())
    expect((await client.rooms.get(ROOM)).myParticipant?.role).toBe('initiator')
    expect(supabase.lastRpc()).toEqual({ name: 'room_get', args: { room_id: IDS.room } })
    supabase.rpcData(RPC.roomJoin, fixtures.roomDto())
    await client.rooms.join({ roomId: ROOM, mediaState: 'audio', consentLevel: 'group' })
    expect(supabase.lastRpc()).toEqual({
      name: 'room_join',
      args: { room_id: IDS.room, media_state: 'audio', consent_level: 'group' },
    })
    supabase.rpcData(RPC.roomInviteJoin, fixtures.roomDto())
    await client.rooms.joinWithInvite({
      token: 'tok',
      mediaState: 'watching',
      consentLevel: 'invited',
    })
    expect(supabase.lastRpc()).toEqual({
      name: 'room_invite_join',
      args: { token: 'tok', media_state: 'watching', consent_level: 'invited' },
    })
  })

  it('join surfaces consent_required', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcError(RPC.roomJoin, postgrestRaise('consent_required'))
    expect(
      (
        await earthRejection(
          client.rooms.join({ roomId: ROOM, mediaState: 'camera', consentLevel: 'invited' }),
        )
      ).code,
    ).toBe('consent_required')
  })

  it('setMediaState, consent and setVisibility return RoomVisibilityChangeDto', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(
      RPC.roomSetMediaState,
      fixtures.roomVisibilityChange({
        applied: true,
        pendingVisibility: null,
        pendingParticipantIds: [],
      }),
    )
    const change = await client.rooms.setMediaState({ roomId: ROOM, mediaState: 'watching' })
    expect(supabase.lastRpc()).toEqual({
      name: 'room_set_media_state',
      args: { room_id: IDS.room, media_state: 'watching', consent_level: null },
    })
    expect(change.applied).toBe(true)
    await client.rooms.setMediaState({
      roomId: ROOM,
      mediaState: 'camera',
      consentLevel: 'friends',
    })
    expect(supabase.lastRpc().args).toEqual({
      room_id: IDS.room,
      media_state: 'camera',
      consent_level: 'friends',
    })
    supabase.rpcData(RPC.roomConsent, fixtures.roomVisibilityChange())
    expect(
      (await client.rooms.consent({ roomId: ROOM, level: 'friends' })).pendingParticipantIds,
    ).toEqual([IDS.participant])
    expect(supabase.lastRpc()).toEqual({
      name: 'room_consent',
      args: { room_id: IDS.room, level: 'friends' },
    })
    supabase.rpcData(RPC.roomSetVisibility, fixtures.roomVisibilityChange())
    await client.rooms.setVisibility({ roomId: ROOM, visibility: 'friends', joinPolicy: 'friends' })
    expect(supabase.lastRpc()).toEqual({
      name: 'room_set_visibility',
      args: { room_id: IDS.room, visibility: 'friends', join_policy: 'friends' },
    })
  })

  it('setVisibility refuses join policies the UI never offers', async () => {
    const { client, supabase } = createTestClient()
    expect(
      (
        await earthRejection(
          client.rooms.setVisibility({ roomId: ROOM, visibility: 'invited', joinPolicy: 'anyone' }),
        )
      ).code,
    ).toBe('invalid_input')
    expect(supabase.rpcCalls).toHaveLength(0)
  })

  it('moderator actions map their rpcs', async () => {
    const { client, supabase } = createTestClient()
    for (const name of [
      RPC.roomSetJoinPolicy,
      RPC.roomSetGuestsDisabled,
      RPC.roomAdmit,
      RPC.roomEnd,
      RPC.roomRemoveParticipant,
    ]) {
      supabase.rpcData(name, null)
    }
    await client.rooms.setJoinPolicy({ roomId: ROOM, joinPolicy: 'request' })
    expect(supabase.lastRpc()).toEqual({
      name: 'room_set_join_policy',
      args: { room_id: IDS.room, join_policy: 'request' },
    })
    await client.rooms.setGuestsDisabled({ roomId: ROOM, disabled: true })
    expect(supabase.lastRpc()).toEqual({
      name: 'room_set_guests_disabled',
      args: { room_id: IDS.room, disabled: true },
    })
    await client.rooms.admit({ roomId: ROOM, participantId: IDS.participant })
    expect(supabase.lastRpc()).toEqual({
      name: 'room_admit',
      args: { room_id: IDS.room, participant_id: IDS.participant },
    })
    await client.rooms.end({ roomId: ROOM })
    expect(supabase.lastRpc()).toEqual({
      name: 'room_end',
      args: { room_id: IDS.room, reason: null },
    })
    await client.rooms.removeParticipant({ roomId: ROOM, participantId: IDS.participant })
    expect(supabase.lastRpc()).toEqual({
      name: 'room_remove_participant',
      args: { room_id: IDS.room, participant_id: IDS.participant, block_from_room: false },
    })
    await client.rooms.removeParticipant({
      roomId: ROOM,
      participantId: IDS.participant,
      blockFromRoom: true,
    })
    expect(supabase.lastRpc().args).toMatchObject({ block_from_room: true })
  })

  it('leave returns the moderator transfer', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.roomLeave, fixtures.roomLeave())
    expect((await client.rooms.leave(ROOM)).transferredTo).toBe(IDS.maya)
    expect(supabase.lastRpc()).toEqual({ name: 'room_leave', args: { room_id: IDS.room } })
  })

  it('invites convert minutes to seconds and preview publicly', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.roomInviteCreate, fixtures.roomInviteCreate())
    await client.rooms.invites.create({
      roomId: ROOM,
      expiresInMinutes: 30,
      joinPolicyOverride: 'anyone_with_link',
    })
    expect(supabase.lastRpc()).toEqual({
      name: 'room_invite_create',
      args: {
        room_id: IDS.room,
        expires_in_seconds: 1800,
        join_policy_override: 'anyone_with_link',
      },
    })
    await client.rooms.invites.create({ roomId: ROOM })
    expect(supabase.lastRpc().args).toEqual({
      room_id: IDS.room,
      expires_in_seconds: null,
      join_policy_override: null,
    })
    supabase.rpcData(RPC.roomInvitePreview, fixtures.roomInvitePreview())
    expect((await client.rooms.invites.preview('tok')).guestsAllowed).toBe(true)
    expect(supabase.lastRpc()).toEqual({ name: 'room_invite_preview', args: { token: 'tok' } })
  })

  it('token posts to /api/rooms/:id/token with a bearer', async () => {
    const { client, fetch } = createTestClient({
      accessToken: 'tok',
      fetchHandler: { json: fixtures.roomToken() },
    })
    const token = await client.rooms.token(ROOM)
    expect(token.identity).toBe(`h:${IDS.xavier}`)
    const request = fetch.lastRequest()
    expect(request.url).toBe(`https://api.earth.test/api/rooms/${IDS.room}/token`)
    expect(request.method).toBe('POST')
    expect(request.headers['authorization']).toBe('Bearer tok')
    expect(request.body).toEqual({})
  })

  it('token needs a session and maps route errors', async () => {
    const { client, fetch } = createTestClient()
    expect((await earthRejection(client.rooms.token(ROOM))).code).toBe('not_authenticated')
    expect(fetch.requests).toHaveLength(0)
    const ended = createTestClient({
      accessToken: 'tok',
      fetchHandler: { status: 410, json: { error: { code: 'room_ended', message: 'room_ended' } } },
    })
    expect((await earthRejection(ended.client.rooms.token(ROOM))).code).toBe('room_ended')
  })
})

describe('guest', () => {
  it('createSession omits media_state unless chosen', async () => {
    const { client, supabase } = createTestClient({ accessToken: 'anon_tok' })
    supabase.rpcData(RPC.guestSessionCreate, fixtures.guestSession())
    const session = await client.guest.createSession({
      inviteToken: 'tok',
      displayName: 'Sam',
      deviceFingerprintHash: 'fp',
    })
    expect(supabase.lastRpc()).toEqual({
      name: 'guest_session_create',
      args: { token: 'tok', display_name: 'Sam', device_fingerprint_hash: 'fp' },
    })
    expect(session.guestSessionId).toBe(IDS.guest)
    await client.guest.createSession({
      inviteToken: 'tok',
      displayName: 'Sam',
      mediaState: 'watching',
    })
    expect(supabase.lastRpc().args).toEqual({
      token: 'tok',
      display_name: 'Sam',
      device_fingerprint_hash: null,
      media_state: 'watching',
    })
  })

  it('createSession surfaces guests_disabled and validates names', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcError(RPC.guestSessionCreate, postgrestRaise('guests_disabled'))
    expect(
      (await earthRejection(client.guest.createSession({ inviteToken: 'tok', displayName: 'Sam' })))
        .code,
    ).toBe('guests_disabled')
    expect(
      (await earthRejection(client.guest.createSession({ inviteToken: 'tok', displayName: '   ' })))
        .code,
    ).toBe('invalid_input')
  })

  it('get parses sessions with defaults for missing counts', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.guestSessionGet, fixtures.guestSessions())
    expect((await client.guest.get()).humansMet).toBe(2)
    supabase.rpcData(RPC.guestSessionGet, {})
    expect(await client.guest.get()).toEqual({ sessions: [], roomsJoined: 0, humansMet: 0 })
  })
})
