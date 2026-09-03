import {
  GuestSessionDtoSchema,
  MediaGrantDtoSchema,
  RoomDtoSchema,
  RoomInviteCreateDtoSchema,
  RoomInvitePreviewDtoSchema,
  RoomLeaveDtoSchema,
} from '@earth/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type TestDb } from '../harness'
import {
  befriend,
  count,
  createGuest,
  createGuestSession,
  createRoomInvite,
  createUnclaimed,
  getRoom,
  human,
  joinRoom,
  roomRow,
  rpcAt,
  scalar,
  secondsFromNow,
  setFlag,
  startStandaloneRoom,
  type Guest,
  type Human,
} from './fixtures'

describe('guests and room invites (spec §34–§35, §42–§43, SCREEN 17–19; DB_API §3)', () => {
  let db: TestDb
  let host: Human
  let cohost: Human

  beforeAll(async () => {
    db = await createTestDb()
    host = await human(db, 'Host')
    cohost = await human(db, 'Cohost')
    await befriend(db, host, cohost)
  })

  afterAll(async () => {
    await db.drop()
  })

  async function liveRoom(): Promise<{ roomId: string; token: string }> {
    const started = await startStandaloneRoom(db, host, 'Hangout')
    const invite = await createRoomInvite(db, started.room.id, host)
    return { roomId: started.room.id, token: invite.token }
  }

  describe('room_invite_create / room_invite_preview', () => {
    it('active Human participants create links; the token is returned once and stored hashed', async () => {
      const started = await startStandaloneRoom(db, host)
      const invite = RoomInviteCreateDtoSchema.parse(
        await db.rpc('room_invite_create', { room_id: started.room.id, expires_in_seconds: 3600 }, host.as),
      )
      expect(invite.url).toBe(`https://earth.social/live/${invite.token}`)
      expect(await count(db, 'public.room_invites', 'room_id = $1', [started.room.id])).toBe(1)
      expect(await count(db, 'public.room_invites', 'token_hash = $1', [invite.token])).toBe(0)
      expect(await scalar(db, 'token_hash from public.room_invites where room_id = $1', [started.room.id])).toMatch(/^[0-9a-f]{64}$/)
      // Seeing the room is not enough: only active participants create links; strangers do not see it.
      await db.expectError(db.rpc('room_invite_create', { room_id: started.room.id }, cohost.as), 'not_in_room')
      const stranger = await human(db, 'Stranger')
      await db.expectError(db.rpc('room_invite_create', { room_id: started.room.id }, stranger.as), 'room_not_found')
      await db.expectError(
        db.rpc('room_invite_create', { room_id: started.room.id, expires_in_seconds: 48 * 3600 }, host.as),
        'invalid_input',
      )
      await db.expectError(db.rpc('room_invite_create', { room_id: started.room.id }, 'visitor'), 'not_authenticated')
      // A non-moderator participant may create a plain link but not one with a policy override.
      const guest = await createGuest(db)
      await createGuestSession(db, guest, invite.token, 'Sam')
      await db.expectError(db.rpc('room_invite_create', { room_id: started.room.id }, guest.as), 'guest_not_allowed')
      await db.rpc('room_end', { room_id: started.room.id }, host.as)
      await db.expectError(db.rpc('room_invite_create', { room_id: started.room.id }, host.as), 'room_ended')
    })

    it('preview shows publishers, context, join policy, guestsAllowed and ended (RoomInvitePreviewDto)', async () => {
      const { roomId, token } = await liveRoom()
      const preview = RoomInvitePreviewDtoSchema.parse(await db.rpc('room_invite_preview', { token }, 'visitor'))
      expect(preview).toEqual({
        roomId,
        contextTitle: null,
        visibility: 'friends',
        joinPolicy: 'friends',
        participants: [{ displayName: 'Host', avatarUrl: null, isGuest: false }],
        invitedByDisplayName: 'Host',
        guestsAllowed: true,
        ended: false,
      })
      await setFlag(db, 'GUEST_ROOMS_ENABLED', false)
      expect(RoomInvitePreviewDtoSchema.parse(await db.rpc('room_invite_preview', { token }, 'visitor')).guestsAllowed).toBe(false)
      await setFlag(db, 'GUEST_ROOMS_ENABLED', true)
      await db.rpc('room_set_guests_disabled', { room_id: roomId, disabled: true }, host.as)
      expect(RoomInvitePreviewDtoSchema.parse(await db.rpc('room_invite_preview', { token }, 'visitor')).guestsAllowed).toBe(false)
      await db.rpc('room_set_guests_disabled', { room_id: roomId, disabled: false }, host.as)
      await db.expectError(db.rpc('room_invite_preview', { token: 'nope' }, 'visitor'), 'invite_invalid')
      await db.rpc('room_end', { room_id: roomId }, host.as)
      const ended = RoomInvitePreviewDtoSchema.parse(await db.rpc('room_invite_preview', { token }, cohost.as))
      expect(ended).toMatchObject({ ended: true, guestsAllowed: false, participants: [] })
    })
  })

  describe('guest_session_create', () => {
    it('requires an anonymous auth user', async () => {
      const { roomId, token } = await liveRoom()
      await db.expectError(db.rpc('guest_session_create', { token, display_name: 'Sam' }, 'visitor'), 'not_authenticated')
      await db.expectError(db.rpc('guest_session_create', { token, display_name: 'Sam' }, cohost.as), 'forbidden')
      const unclaimed = await createUnclaimed(db)
      await db.expectError(db.rpc('guest_session_create', { token, display_name: 'Sam' }, unclaimed.as), 'forbidden')
      const guest = await createGuest(db)
      const session = await createGuestSession(db, guest, token, ' Sam ')
      expect(GuestSessionDtoSchema.parse(session)).toMatchObject({ roomId, displayName: 'Sam' })
      expect(session.sessionSecret.length).toBeGreaterThan(20)
      expect(await scalar(db, 'session_secret_hash from public.guest_sessions where id = $1', [session.guestSessionId])).toMatch(/^[0-9a-f]{64}$/)
      expect(await scalar(db, 'auth_user_id from public.guest_sessions where id = $1', [session.guestSessionId])).toBe(guest.userId)
      const room = await getRoom(db, roomId, guest.as)
      expect(room.myParticipant).toMatchObject({
        guestSessionId: session.guestSessionId,
        humanId: null,
        isGuest: true,
        displayName: 'Sam',
        mediaState: 'audio',
        role: 'participant',
        status: 'active',
        audienceConsentLevel: 'friends',
        relationToViewer: null,
      })
      expect(await roomRow(db, roomId)).toMatchObject({ active_human_count: 1, active_participant_count: 2 })
      expect(await scalar(db, 'use_count from public.room_invites where room_id = $1', [roomId])).toBe(1)
      await db.rpc('room_end', { room_id: roomId }, host.as)
    })

    it('requires an active room, GUEST_ROOMS_ENABLED, guests not disabled and a usable invite', async () => {
      const { roomId, token } = await liveRoom()
      const guest = await createGuest(db)
      await db.expectError(db.rpc('guest_session_create', { token, display_name: '' }, guest.as), 'invalid_input')
      await db.expectError(db.rpc('guest_session_create', { token: 'nope', display_name: 'Sam' }, guest.as), 'invite_invalid')
      await setFlag(db, 'GUEST_ROOMS_ENABLED', false)
      await db.expectError(db.rpc('guest_session_create', { token, display_name: 'Sam' }, guest.as), 'feature_disabled')
      await setFlag(db, 'GUEST_ROOMS_ENABLED', true)
      await db.rpc('room_set_guests_disabled', { room_id: roomId, disabled: true }, host.as)
      await db.expectError(db.rpc('guest_session_create', { token, display_name: 'Sam' }, guest.as), 'guests_disabled')
      await db.rpc('room_set_guests_disabled', { room_id: roomId, disabled: false }, host.as)
      const expired = await createRoomInvite(db, roomId, host, { expiresInSeconds: 60 })
      await expect(
        rpcAt(db, 'guest_session_create', { token: expired.token, display_name: 'Sam' }, guest.as, secondsFromNow(120)),
      ).rejects.toMatchObject({ message: 'invite_expired' })
      await db.rpc('room_end', { room_id: roomId }, host.as)
      await db.expectError(db.rpc('guest_session_create', { token, display_name: 'Sam' }, guest.as), 'room_ended')
    })

    it('is rate limited to 5 per 10 minutes for a Guest credential (half of 10)', async () => {
      const { roomId, token } = await liveRoom()
      const guest = await createGuest(db)
      for (let i = 0; i < 5; i += 1) {
        await createGuestSession(db, guest, token, `Sam ${i}`)
      }
      // Re-entering rotates the same session (one usable session per credential and room).
      expect(await count(db, 'public.guest_sessions', 'room_id = $1 and auth_user_id = $2', [roomId, guest.userId])).toBe(1)
      await db.expectError(db.rpc('guest_session_create', { token, display_name: 'Sam' }, guest.as), 'rate_limited')
      await db.rpc('room_end', { room_id: roomId }, host.as)
    })
  })

  describe('guest in room (SCREEN 18)', () => {
    let roomId: string
    let token: string
    let guest: Guest
    let sessionId: string

    beforeAll(async () => {
      const room = await liveRoom()
      roomId = room.roomId
      token = room.token
      guest = await createGuest(db)
      sessionId = (await createGuestSession(db, guest, token, 'Sam', { fingerprint: 'fp-guest-1234' })).guestSessionId
    })

    it('gets a media grant with identity g:<session id> and can change media state', async () => {
      const grant = MediaGrantDtoSchema.parse(await db.rpc('room_media_grant', { room_id: roomId }, guest.as))
      expect(grant).toEqual({
        livekitRoom: roomId,
        identity: `g:${sessionId}`,
        name: 'Sam',
        role: 'participant',
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        ttlSeconds: 7200,
      })
      await db.rpc('room_set_media_state', { room_id: roomId, media_state: 'camera' }, guest.as)
      expect(await scalar(db, 'media_state::text from public.room_participants where guest_session_id = $1', [sessionId])).toBe('camera')
      // Another guest credential is not in this room.
      const other = await createGuest(db)
      await db.expectError(db.rpc('room_media_grant', { room_id: roomId }, other.as), 'not_in_room')
      await db.expectError(db.rpc('room_get', { room_id: roomId }, other.as), 'room_not_found')
    })

    it('cannot expand visibility, create links, consent, or discover Lives (guest_not_allowed)', async () => {
      await db.expectError(db.rpc('room_set_visibility', { room_id: roomId, visibility: 'world' }, guest.as), 'guest_not_allowed')
      await db.expectError(db.rpc('room_invite_create', { room_id: roomId }, guest.as), 'guest_not_allowed')
      await db.expectError(db.rpc('room_consent', { room_id: roomId, level: 'world' }, guest.as), 'guest_not_allowed')
      await db.expectError(db.rpc('room_set_join_policy', { room_id: roomId, join_policy: 'anyone' }, guest.as), 'guest_not_allowed')
      await db.expectError(db.rpc('room_end', { room_id: roomId }, guest.as), 'guest_not_allowed')
      await db.expectError(db.rpc('live_candidates', { scope: 'world' }, guest.as), 'guest_not_allowed')
      await db.expectError(db.rpc('room_join', { room_id: roomId, media_state: 'audio' }, guest.as).then(() => db.rpc('room_start', { context_type: 'standalone' }, guest.as)), 'not_a_human')
    })

    it('can leave and come back through room_join while the session is usable', async () => {
      const left = RoomLeaveDtoSchema.parse(await db.rpc('room_leave', { room_id: roomId }, guest.as))
      expect(left.transferredTo).toBeNull()
      expect(await scalar(db, 'status::text from public.room_participants where guest_session_id = $1', [sessionId])).toBe('left')
      expect(await roomRow(db, roomId)).toMatchObject({ active_participant_count: 1 })
      const back = RoomDtoSchema.parse(await db.rpc('room_join', { room_id: roomId, media_state: 'audio' }, guest.as))
      expect(back.myParticipant).toMatchObject({ guestSessionId: sessionId, status: 'active', mediaState: 'audio' })
      // The seat that was left stays as history; exactly one live seat per session.
      expect(await count(db, 'public.room_participants', "guest_session_id = $1 and status = 'active'", [sessionId])).toBe(1)
      expect(await count(db, 'public.room_participants', 'guest_session_id = $1', [sessionId])).toBe(2)
      await db.expectError(db.rpc('room_leave', { room_id: roomId }, await createGuest(db).then((g) => g.as)), 'not_in_room')
    })

    it('guest_session_get counts distinct rooms joined and Humans met', async () => {
      await joinRoom(db, roomId, cohost, 'watching')
      const before = await db.rpc<{ roomsJoined: number; humansMet: number; current: unknown; sessions: unknown[] }>('guest_session_get', {}, guest.as)
      expect(before).toMatchObject({ roomsJoined: 1, humansMet: 2 })
      expect(GuestSessionDtoSchema.parse(before.current)).toMatchObject({ guestSessionId: sessionId, roomId })
      expect(before.sessions).toHaveLength(1)
      const second = await liveRoom()
      await createGuestSession(db, guest, second.token, 'Sam')
      const after = await db.rpc<{ roomsJoined: number; humansMet: number }>('guest_session_get', {}, guest.as)
      expect(after).toMatchObject({ roomsJoined: 2, humansMet: 2 })
      await db.rpc('room_end', { room_id: second.roomId }, host.as)
      await db.expectError(db.rpc('guest_session_get', {}, host.as), 'guest_not_allowed')
      await db.expectError(db.rpc('guest_session_get', {}, 'visitor'), 'not_authenticated')
    })

    it('moderator removal with block_from_room blocks the fingerprint and the credential for new sessions', async () => {
      const room = await getRoom(db, roomId, host.as)
      const participant = room.participants.find((p) => p.guestSessionId === sessionId)
      expect(participant).toBeDefined()
      await db.expectError(
        db.rpc('room_remove_participant', { room_id: roomId, participant_id: participant?.id, block_from_room: true }, cohost.as),
        'not_a_moderator',
      )
      const removed = RoomDtoSchema.parse(
        await db.rpc('room_remove_participant', { room_id: roomId, participant_id: participant?.id, block_from_room: true }, host.as),
      )
      expect(removed.participants.some((p) => p.guestSessionId === sessionId)).toBe(false)
      expect(
        await scalar(db, 'status::text from public.room_participants where guest_session_id = $1 order by joined_at desc limit 1', [sessionId]),
      ).toBe('removed')
      expect(await scalar(db, 'removed_at is not null from public.guest_sessions where id = $1', [sessionId])).toBe(true)
      expect(await count(db, 'public.room_blocked_fingerprints', 'room_id = $1 and fingerprint_hash = $2', [roomId, 'fp-guest-1234'])).toBe(1)
      // The removed guest is out: no room, no grant, no new session with the same credential.
      await db.expectError(db.rpc('room_get', { room_id: roomId }, guest.as), 'room_not_found')
      await db.expectError(db.rpc('room_media_grant', { room_id: roomId }, guest.as), 'not_in_room')
      await db.expectError(db.rpc('guest_session_create', { token, display_name: 'Sam' }, guest.as), 'blocked')
      // A new credential presenting the blocked fingerprint is refused; a clean one is admitted.
      const newDevice = await createGuest(db)
      await db.expectError(
        db.rpc('guest_session_create', { token, display_name: 'Sam', device_fingerprint_hash: 'fp-guest-1234' }, newDevice.as),
        'blocked',
      )
      await createGuestSession(db, newDevice, token, 'Pat', { fingerprint: 'fp-other-5678' })
      expect(await count(db, 'private.audit_log', "action = 'room_remove_participant' and target_id = $1", [roomId])).toBe(1)
    })

    it('disabling guests removes every active guest and stops new sessions', async () => {
      const disabled = RoomDtoSchema.parse(await db.rpc('room_set_guests_disabled', { room_id: roomId, disabled: true }, host.as))
      expect(disabled.guestsDisabled).toBe(true)
      expect(disabled.participants.some((p) => p.isGuest)).toBe(false)
      expect(await count(db, 'public.room_participants', "room_id = $1 and guest_session_id is not null and status = 'active'", [roomId])).toBe(0)
      await db.expectError(db.rpc('guest_session_create', { token, display_name: 'Sam' }, await createGuest(db).then((g) => g.as)), 'guests_disabled')
      await db.rpc('room_set_guests_disabled', { room_id: roomId, disabled: false }, host.as)
      await db.rpc('room_end', { room_id: roomId }, host.as)
    })
  })

  describe('guest session expiry (spec §34 "expires with room plus a short grace period")', () => {
    it('ending the room expires guest sessions after the grace; the guest loses the room afterwards', async () => {
      const { roomId, token } = await liveRoom()
      const guest = await createGuest(db)
      const session = await createGuestSession(db, guest, token, 'Sam')
      await db.rpc('room_end', { room_id: roomId }, host.as)
      await db.expectError(db.rpc('room_media_grant', { room_id: roomId }, guest.as), 'room_ended')
      // Within the grace the guest can still read their (ended) room.
      expect((await getRoom(db, roomId, guest.as)).status).toBe('ended')
      const expiresAt = await scalar<Date>(db, 'expires_at from public.guest_sessions where id = $1', [session.guestSessionId])
      expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 600_000 + 5_000)
      await expect(
        rpcAt(db, 'room_get', { room_id: roomId }, guest.as, secondsFromNow(601)),
      ).rejects.toMatchObject({ message: 'room_not_found' })
      const current = await rpcAt<{ current: unknown }>(db, 'guest_session_get', {}, guest.as, secondsFromNow(601))
      expect(current.current).toBeNull()
    })

    it('rooms_sweep expires sessions past their expiry while the room is still open', async () => {
      const { roomId, token } = await liveRoom()
      const guest = await createGuest(db)
      const session = await createGuestSession(db, guest, token, 'Sam')
      const swept = await rpcAt<{ guestSessionsExpired: number }>(db, 'rooms_sweep', {}, 'service', secondsFromNow(25 * 3600))
      expect(swept.guestSessionsExpired).toBe(1)
      expect(await scalar(db, 'status::text from public.room_participants where guest_session_id = $1', [session.guestSessionId])).toBe('left')
      await expect(rpcAt(db, 'room_media_grant', { room_id: roomId }, guest.as, secondsFromNow(25 * 3600))).rejects.toMatchObject({ message: 'not_in_room' })
      await db.rpc('room_end', { room_id: roomId }, host.as)
    })
  })
})
