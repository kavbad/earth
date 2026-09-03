import {
  MediaGrantDtoSchema,
  RoomDtoSchema,
  RoomLeaveDtoSchema,
  RoomStartDtoSchema,
  RoomVisibilityChangeDtoSchema,
} from '@earth/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type TestDb } from '../harness'
import {
  NIL_UUID,
  addMember,
  befriend,
  block,
  count,
  createGroup,
  createGuest,
  createGuestSession,
  createRoomInvite,
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
  setFlag,
  startGroupRoom,
  startStandaloneRoom,
  type GroupFixture,
  type Human,
} from './fixtures'

describe('room lifecycle (spec §57, §59, §61–§62; DB_API §3; ARCHITECTURE §10)', () => {
  let db: TestDb
  let owner: Human
  let member: Human
  let outsider: Human
  let group: GroupFixture

  beforeAll(async () => {
    db = await createTestDb()
    owner = await human(db, 'Owner')
    member = await human(db, 'Member')
    outsider = await human(db, 'Outsider')
    group = await createGroup(db, owner, 'Weekend Crew')
    await addMember(db, group, member)
  })

  afterAll(async () => {
    await db.drop()
  })

  describe('room_start', () => {
    it('creates a group room with the group defaults and the initiator on camera (RoomStartDto)', async () => {
      const started = await startGroupRoom(db, owner, group, '  Cooking dinner ')
      expect(started.created).toBe(true)
      expect(started.room).toMatchObject({
        contextType: 'group',
        contextId: group.groupId,
        initiatedByHumanId: owner.humanId,
        visibility: 'group',
        joinPolicy: 'group',
        status: 'active',
        areaPrecision: 'none',
        pendingVisibility: null,
        contextTitle: 'Weekend Crew',
        guestsDisabled: false,
      })
      expect(started.room.myParticipant).toMatchObject({
        humanId: owner.humanId,
        role: 'initiator',
        mediaState: 'camera',
        status: 'active',
        audienceConsentLevel: 'group',
        isGuest: false,
        relationToViewer: 'self',
      })
      expect(started.room.participants).toHaveLength(1)
      expect(await scalar(db, 'active_room_id from public.groups where id = $1', [group.groupId])).toBe(
        started.room.id,
      )
      expect(
        await scalar(db, 'active_room_id from public.conversations where id = $1', [group.conversationId]),
      ).toBe(started.room.id)
      expect(
        await count(db, 'public.messages', "conversation_id = $1 and type = 'system' and text like '%started a video'", [
          group.conversationId,
        ]),
      ).toBe(1)
      const row = await roomRow(db, started.room.id)
      expect(row).toMatchObject({ active_human_count: 1, active_participant_count: 1 })
    })

    it('group room start is idempotent: the second caller gets the existing room as a watching participant', async () => {
      const first = await startGroupRoom(db, owner, group)
      const second = await startGroupRoom(db, member, group)
      expect(second.created).toBe(false)
      expect(second.room.id).toBe(first.room.id)
      expect(second.room.myParticipant).toMatchObject({
        humanId: member.humanId,
        role: 'viewer',
        mediaState: 'watching',
        status: 'active',
      })
      // The initiator calling again does not duplicate their participant row.
      const again = await startGroupRoom(db, owner, group)
      expect(again.created).toBe(false)
      expect(again.room.participants).toHaveLength(2)
      expect(await count(db, 'public.rooms', "context_id = $1 and status = 'active'", [group.groupId])).toBe(1)
    })

    it('non-members cannot start or join a group room; visitors and guests cannot start rooms', async () => {
      const started = await startGroupRoom(db, owner, group)
      await db.expectError(
        db.rpc('room_start', { context_type: 'group', context_id: group.groupId }, outsider.as),
        'not_a_member',
      )
      await db.expectError(
        db.rpc('room_join', { room_id: started.room.id, media_state: 'watching' }, outsider.as),
        'room_not_found',
      )
      await db.expectError(
        db.rpc('room_start', { context_type: 'group', context_id: group.groupId }, 'visitor'),
        'not_authenticated',
      )
      const guest = await createGuest(db)
      await db.expectError(
        db.rpc('room_start', { context_type: 'group', context_id: group.groupId }, guest.as),
        'not_a_human',
      )
      await db.expectError(
        db.rpc('room_start', { context_type: 'group', context_id: NIL_UUID }, owner.as),
        'group_not_found',
      )
    })

    it('direct room invites both members and sets the conversation pointer', async () => {
      const friend = await human(db, 'Dm')
      const conversationId = await directConversation(db, owner, friend)
      const started = RoomStartDtoSchema.parse(
        await db.rpc('room_start', { context_type: 'direct', context_id: conversationId }, owner.as),
      )
      expect(started.room).toMatchObject({ visibility: 'invited', joinPolicy: 'invited_only', contextTitle: 'Dm' })
      const invited = started.room.participants.find((p) => p.humanId === friend.humanId)
      expect(invited).toMatchObject({ status: 'invited', mediaState: 'watching', role: 'participant' })
      expect(
        await scalar(db, 'active_room_id from public.conversations where id = $1', [conversationId]),
      ).toBe(started.room.id)
      // The invited member sees the room and can join on camera (invited_only honours the invite).
      const joined = await joinRoom(db, started.room.id, friend, 'camera', 'invited')
      expect(joined.myParticipant).toMatchObject({ status: 'active', mediaState: 'camera' })
      expect(joined.contextTitle).toBe('Owner')
      // A stranger cannot even see it.
      await db.expectError(db.rpc('room_get', { room_id: started.room.id }, outsider.as), 'room_not_found')
      await db.expectError(
        db.rpc('room_start', { context_type: 'direct', context_id: conversationId }, outsider.as),
        'conversation_not_found',
      )
      await db.rpc('room_end', { room_id: started.room.id }, owner.as)
    })

    it('standalone rooms default to friends/friends and require FRIENDS_LIVE_EXPANSION_ENABLED', async () => {
      const started = await startStandaloneRoom(db, outsider, 'Walk')
      expect(started.room).toMatchObject({ visibility: 'friends', joinPolicy: 'friends', contextId: null })
      await db.rpc('room_end', { room_id: started.room.id }, outsider.as)
      await setFlag(db, 'FRIENDS_LIVE_EXPANSION_ENABLED', false)
      await db.expectError(
        db.rpc('room_start', { context_type: 'standalone' }, outsider.as),
        'feature_disabled',
      )
      await setFlag(db, 'FRIENDS_LIVE_EXPANSION_ENABLED', true)
    })

    it('creating rooms is rate limited (20/h)', async () => {
      const busy = await human(db, 'Busy')
      for (let i = 0; i < 20; i += 1) {
        const started = await startStandaloneRoom(db, busy)
        await db.rpc('room_end', { room_id: started.room.id }, busy.as)
      }
      await db.expectError(db.rpc('room_start', { context_type: 'standalone' }, busy.as), 'rate_limited')
    })
  })

  describe('room_join consent gate', () => {
    it('joining on camera needs consent at least as wide as the room; watching needs none', async () => {
      const started = await startGroupRoom(db, owner, group)
      await db.rpc('room_set_visibility', { room_id: started.room.id, visibility: 'friends' }, owner.as)
      await db.expectError(
        db.rpc('room_join', { room_id: started.room.id, media_state: 'camera', consent_level: 'group' }, member.as),
        'consent_required',
      )
      await db.expectError(
        db.rpc('room_join', { room_id: started.room.id, media_state: 'audio', consent_level: 'invited' }, member.as),
        'consent_required',
      )
      const watching = await joinRoom(db, started.room.id, member, 'watching', 'invited')
      expect(watching.myParticipant).toMatchObject({ mediaState: 'watching', role: 'viewer', status: 'active' })
      const camera = await joinRoom(db, started.room.id, member, 'camera', 'friends')
      expect(camera.myParticipant).toMatchObject({
        mediaState: 'camera',
        role: 'participant',
        audienceConsentLevel: 'friends',
      })
      // Consent only ever widens; a lower level on a later call keeps the recorded one.
      const again = await joinRoom(db, started.room.id, member, 'audio', 'invited')
      expect(again.myParticipant?.audienceConsentLevel).toBe('friends')
      await db.rpc('room_end', { room_id: started.room.id }, owner.as)
    })

    it('room_set_media_state applies the same gate and downgrades to viewer', async () => {
      const started = await startGroupRoom(db, owner, group)
      await joinRoom(db, started.room.id, member, 'watching')
      await db.rpc('room_set_visibility', { room_id: started.room.id, visibility: 'friends' }, owner.as)
      await db.expectError(
        db.rpc('room_set_media_state', { room_id: started.room.id, media_state: 'camera' }, member.as),
        'consent_required',
      )
      await db.rpc(
        'room_set_media_state',
        { room_id: started.room.id, media_state: 'camera', consent_level: 'friends' },
        member.as,
      )
      expect(await participantStatus(db, started.room.id, member.humanId)).toMatchObject({
        media_state: 'camera',
        role: 'participant',
        consent: 'friends',
      })
      await db.rpc('room_set_media_state', { room_id: started.room.id, media_state: 'watching' }, member.as)
      expect(await participantStatus(db, started.room.id, member.humanId)).toMatchObject({
        media_state: 'watching',
        role: 'viewer',
      })
      await db.expectError(
        db.rpc('room_set_media_state', { room_id: started.room.id, media_state: 'camera' }, outsider.as),
        'not_in_room',
      )
      await db.rpc('room_end', { room_id: started.room.id }, owner.as)
    })
  })

  describe('join policies (mirror of canJoinWithMedia)', () => {
    let friendOfOwner: Human
    let friendOfFriend: Human
    let stranger: Human

    beforeAll(async () => {
      friendOfOwner = await human(db, 'Fo')
      friendOfFriend = await human(db, 'Fof')
      stranger = await human(db, 'Stranger')
      await befriend(db, owner, friendOfOwner)
      await befriend(db, friendOfOwner, friendOfFriend)
    })

    it('friends policy admits friends of publishers, friends_of_friends one hop further, request creates waiting', async () => {
      const started = await startStandaloneRoom(db, owner)
      await db.rpc('room_set_visibility', { room_id: started.room.id, visibility: 'extended', join_policy: 'friends' }, owner.as)
      // friendOfOwner watches: a viewer is not a publisher, so friendOfFriend is only a friend of a friend of one.
      const watchingFriend = await joinRoom(db, started.room.id, friendOfOwner, 'watching')
      expect(watchingFriend.myParticipant?.status).toBe('active')
      await db.expectError(
        db.rpc('room_join', { room_id: started.room.id, media_state: 'camera', consent_level: 'extended' }, friendOfFriend.as),
        'join_not_allowed',
      )
      // Watching only needs visibility (friend of a friend of a publisher at `extended`).
      const watching = await joinRoom(db, started.room.id, friendOfFriend, 'watching')
      expect(watching.myParticipant?.mediaState).toBe('watching')
      await db.rpc('room_set_join_policy', { room_id: started.room.id, join_policy: 'friends_of_friends' }, owner.as)
      // Consenting up to `world` now lets the later Open up apply without a second consent step.
      const fof = await joinRoom(db, started.room.id, friendOfFriend, 'camera', 'world')
      expect(fof.myParticipant?.status).toBe('active')
      // Once friendOfOwner publishes, friendOfFriend is a direct friend of a publisher and `friends` admits them.
      await db.rpc('room_set_join_policy', { room_id: started.room.id, join_policy: 'friends' }, owner.as)
      const joined = await joinRoom(db, started.room.id, friendOfOwner, 'camera', 'world')
      expect(joined.myParticipant?.status).toBe('active')
      expect((await joinRoom(db, started.room.id, friendOfFriend, 'camera', 'world')).myParticipant?.status).toBe('active')
      // A stranger cannot see an extended room at all.
      await db.expectError(db.rpc('room_get', { room_id: started.room.id }, stranger.as), 'room_not_found')

      const opened = RoomVisibilityChangeDtoSchema.parse(
        await db.rpc('room_set_visibility', { room_id: started.room.id, visibility: 'world', join_policy: 'request' }, owner.as),
      )
      expect(opened.applied).toBe(true)
      const waiting = await joinRoom(db, started.room.id, stranger, 'camera', 'world')
      expect(waiting.myParticipant?.status).toBe('waiting')
      const admitted = RoomDtoSchema.parse(
        await db.rpc('room_admit', { room_id: started.room.id, participant_id: waiting.myParticipant?.id }, owner.as),
      )
      expect(admitted.participants.find((p) => p.humanId === stranger.humanId)?.status).toBe('active')

      await db.rpc('room_set_join_policy', { room_id: started.room.id, join_policy: 'anyone_with_link' }, owner.as)
      const another = await human(db, 'Linkless')
      await db.expectError(
        db.rpc('room_join', { room_id: started.room.id, media_state: 'camera', consent_level: 'world' }, another.as),
        'join_not_allowed',
      )
      const invite = await createRoomInvite(db, started.room.id, owner)
      const viaLink = RoomDtoSchema.parse(
        await db.rpc('room_invite_join', { token: invite.token, media_state: 'camera', consent_level: 'world' }, another.as),
      )
      expect(viaLink.myParticipant?.status).toBe('active')
      await db.expectError(
        db.rpc('room_set_join_policy', { room_id: started.room.id, join_policy: 'group' }, owner.as),
        'invalid_input',
      )
      await db.rpc('room_end', { room_id: started.room.id }, owner.as)
    })

    it('group join policy admits members only; removed participants can never rejoin', async () => {
      const started = await startGroupRoom(db, owner, group)
      await db.rpc('room_set_visibility', { room_id: started.room.id, visibility: 'friends', join_policy: 'group' }, owner.as)
      await db.expectError(
        db.rpc('room_join', { room_id: started.room.id, media_state: 'camera', consent_level: 'friends' }, friendOfOwner.as),
        'join_not_allowed',
      )
      const asMember = await joinRoom(db, started.room.id, member, 'camera', 'friends')
      expect(asMember.myParticipant?.status).toBe('active')
      const removed = RoomDtoSchema.parse(
        await db.rpc(
          'room_remove_participant',
          { room_id: started.room.id, participant_id: participantId(asMember, member.humanId) },
          owner.as,
        ),
      )
      expect(removed.participants.some((p) => p.humanId === member.humanId)).toBe(false)
      expect(await participantStatus(db, started.room.id, member.humanId)).toMatchObject({ status: 'removed' })
      await db.expectError(
        db.rpc('room_join', { room_id: started.room.id, media_state: 'watching' }, member.as),
        'room_not_found',
      )
      await db.expectError(
        db.rpc('room_remove_participant', { room_id: started.room.id, participant_id: NIL_UUID }, owner.as),
        'not_in_room',
      )
      await db.expectError(
        db.rpc('room_remove_participant', { room_id: started.room.id, participant_id: participantId(removed, owner.humanId) }, owner.as),
        'invalid_input',
      )
      await db.rpc('room_end', { room_id: started.room.id }, owner.as)
    })
  })

  describe('leaving, moderator transfer, ending', () => {
    it('sole moderator leaving transfers to the earliest active verified Human, never to a guest', async () => {
      const started = await startStandaloneRoom(db, owner)
      const roomId = started.room.id
      const guest = await createGuest(db)
      const invite = await createRoomInvite(db, roomId, owner)
      await createGuestSession(db, guest, invite.token, 'Sam')
      const early = await human(db, 'Early')
      const late = await human(db, 'Late')
      await befriend(db, owner, early)
      await befriend(db, owner, late)
      await joinRoom(db, roomId, early, 'watching')
      await joinRoom(db, roomId, late, 'camera', 'friends')

      const left = RoomLeaveDtoSchema.parse(await db.rpc('room_leave', { room_id: roomId }, owner.as))
      expect(left.transferredTo).toBe(early.humanId)
      expect(await participantStatus(db, roomId, early.humanId)).toMatchObject({ role: 'moderator' })
      expect(await participantStatus(db, roomId, owner.humanId)).toMatchObject({ status: 'left' })
      // The new moderator can moderate; the other participant cannot.
      await db.expectError(
        db.rpc('room_set_visibility', { room_id: roomId, visibility: 'invited' }, late.as),
        'not_a_moderator',
      )
      await db.rpc('room_set_join_policy', { room_id: roomId, join_policy: 'request' }, early.as)
      // A moderator that is not the sole one leaving transfers nothing.
      const second = RoomLeaveDtoSchema.parse(await db.rpc('room_leave', { room_id: roomId }, late.as))
      expect(second.transferredTo).toBeNull()
      // Last Human leaves: only the guest remains; nobody becomes moderator.
      const third = RoomLeaveDtoSchema.parse(await db.rpc('room_leave', { room_id: roomId }, early.as))
      expect(third.transferredTo).toBeNull()
      expect(await roomRow(db, roomId)).toMatchObject({ status: 'active', active_human_count: 0, active_participant_count: 1 })
      expect(await count(db, 'public.room_participants', "room_id = $1 and role in ('initiator', 'moderator') and status = 'active'", [roomId])).toBe(0)
      await db.expectError(db.rpc('room_leave', { room_id: roomId }, early.as), 'not_in_room')
      // Guests cannot own the room: the sweep ends it after the grace (spec §61).
      const swept = await rpcAt<{ roomsEnded: number }>(db, 'rooms_sweep', {}, 'service', secondsFromNow(121))
      expect(swept.roomsEnded).toBe(1)
      expect(await roomRow(db, roomId)).toMatchObject({ status: 'ended', ended_reason: 'no_humans' })
    })

    it('room_end by the moderator ends immediately and clears pointers; non-moderators cannot end', async () => {
      const started = await startGroupRoom(db, owner, group)
      await joinRoom(db, started.room.id, member, 'watching')
      await db.expectError(db.rpc('room_end', { room_id: started.room.id }, member.as), 'not_a_moderator')
      await db.expectError(db.rpc('room_end', { room_id: started.room.id }, outsider.as), 'room_not_found')
      const ended = RoomDtoSchema.parse(await db.rpc('room_end', { room_id: started.room.id, reason: 'done' }, owner.as))
      expect(ended.status).toBe('ended')
      expect(ended.endedAt).not.toBeNull()
      expect(ended.participants).toHaveLength(0)
      expect(await scalar(db, 'active_room_id from public.groups where id = $1', [group.groupId])).toBeNull()
      expect(await scalar(db, 'active_room_id from public.conversations where id = $1', [group.conversationId])).toBeNull()
      expect(await roomRow(db, started.room.id)).toMatchObject({ ended_reason: 'done', active_participant_count: 0 })
      await db.expectError(db.rpc('room_end', { room_id: started.room.id }, owner.as), 'room_ended')
      await db.expectError(db.rpc('room_join', { room_id: started.room.id, media_state: 'watching' }, member.as), 'room_ended')
      // Participants can still read the ended room; a new start creates a fresh one.
      expect((await getRoom(db, started.room.id, member.as)).status).toBe('ended')
      const fresh = await startGroupRoom(db, owner, group)
      expect(fresh.created).toBe(true)
      expect(fresh.room.id).not.toBe(started.room.id)
      await db.rpc('room_end', { room_id: fresh.room.id }, owner.as)
    })
  })

  describe('room_media_grant', () => {
    it('returns MediaGrantDto for active participants and room_ended for ended rooms', async () => {
      const started = await startGroupRoom(db, owner, group)
      const grant = MediaGrantDtoSchema.parse(await db.rpc('room_media_grant', { room_id: started.room.id }, owner.as))
      expect(grant).toEqual({
        livekitRoom: started.room.id,
        identity: `h:${owner.humanId}`,
        name: 'Owner',
        role: 'initiator',
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        ttlSeconds: 7200,
      })
      await joinRoom(db, started.room.id, member, 'watching')
      const viewer = MediaGrantDtoSchema.parse(await db.rpc('room_media_grant', { room_id: started.room.id }, member.as))
      expect(viewer).toMatchObject({ role: 'viewer', canPublish: false, canSubscribe: true })
      await db.expectError(db.rpc('room_media_grant', { room_id: started.room.id }, outsider.as), 'not_in_room')
      await db.expectError(db.rpc('room_media_grant', { room_id: started.room.id }, 'visitor'), 'not_authenticated')
      await db.rpc('room_end', { room_id: started.room.id }, owner.as)
      await db.expectError(db.rpc('room_media_grant', { room_id: started.room.id }, owner.as), 'room_ended')
    })
  })

  describe('room_participant_sync (service) and rooms_sweep', () => {
    it('reconciles LiveKit events, ignores out-of-order ones, transfers moderation', async () => {
      const started = await startGroupRoom(db, owner, group)
      const roomId = started.room.id
      await joinRoom(db, roomId, member, 'camera', 'group')
      // Service-only: not even executable by authenticated callers.
      await expect(
        db.rpc('room_participant_sync', { room_id: roomId, livekit_identity: `h:${owner.humanId}`, event: 'participant_left' }, owner.as),
      ).rejects.toMatchObject({ code: '42501' })
      const leftAt = secondsFromNow(0)
      const left = await db.rpc<{ applied: boolean; ignored: boolean; transferredTo: string | null }>(
        'room_participant_sync',
        { room_id: roomId, livekit_identity: `h:${owner.humanId}`, event: 'participant_left', at: leftAt },
        'service',
      )
      expect(left).toMatchObject({ applied: true, ignored: false, transferredTo: member.humanId })
      expect(await participantStatus(db, roomId, owner.humanId)).toMatchObject({ status: 'left' })
      // An older "left" event arriving late is ignored and reported.
      const stale = await db.rpc<{ applied: boolean; ignored: boolean; reason: string }>(
        'room_participant_sync',
        { room_id: roomId, livekit_identity: `h:${owner.humanId}`, event: 'participant_left', at: secondsFromNow(-60) },
        'service',
      )
      expect(stale).toMatchObject({ applied: false, ignored: true, reason: 'out_of_order' })
      // A "joined" event older than the leave is ignored too; a newer one re-activates.
      const staleJoin = await db.rpc<{ ignored: boolean; reason: string }>(
        'room_participant_sync',
        { room_id: roomId, livekit_identity: `h:${owner.humanId}`, event: 'participant_joined', at: secondsFromNow(-30) },
        'service',
      )
      expect(staleJoin).toMatchObject({ ignored: true, reason: 'out_of_order' })
      const rejoin = await db.rpc<{ applied: boolean }>(
        'room_participant_sync',
        { room_id: roomId, livekit_identity: `h:${owner.humanId}`, event: 'participant_joined', at: secondsFromNow(5) },
        'service',
      )
      expect(rejoin.applied).toBe(true)
      expect(await participantStatus(db, roomId, owner.humanId)).toMatchObject({ status: 'active' })
      const unknown = await db.rpc<{ ignored: boolean; reason: string }>(
        'room_participant_sync',
        { room_id: roomId, livekit_identity: `h:${NIL_UUID}`, event: 'participant_left' },
        'service',
      )
      expect(unknown).toMatchObject({ ignored: true, reason: 'unknown_participant' })
      const finished = await db.rpc<{ applied: boolean }>(
        'room_participant_sync',
        { room_id: roomId, livekit_identity: '', event: 'room_finished' },
        'service',
      )
      expect(finished.applied).toBe(true)
      expect(await roomRow(db, roomId)).toMatchObject({ status: 'ended', ended_reason: 'livekit_finished' })
      await db.expectError(
        db.rpc('room_participant_sync', { room_id: roomId, livekit_identity: 'x', event: 'danced' }, 'service'),
        'invalid_input',
      )
    })

    it('rooms_sweep ends guest-only rooms after the grace period and empty rooms right away', async () => {
      const started = await startStandaloneRoom(db, owner)
      const roomId = started.room.id
      const invite = await createRoomInvite(db, roomId, owner)
      const guest = await createGuest(db)
      await createGuestSession(db, guest, invite.token, 'Sam')
      await db.rpc('room_leave', { room_id: roomId }, owner.as)
      expect(await roomRow(db, roomId)).toMatchObject({ active_human_count: 0, active_participant_count: 1 })
      await expect(db.rpc('rooms_sweep', {}, owner.as)).rejects.toMatchObject({ code: '42501' })

      const early = await rpcAt<{ roomsEnded: number }>(db, 'rooms_sweep', {}, 'service', secondsFromNow(60))
      expect(early.roomsEnded).toBe(0)
      expect((await roomRow(db, roomId)).status).toBe('active')

      const late = await rpcAt<{ roomsEnded: number }>(db, 'rooms_sweep', {}, 'service', secondsFromNow(121))
      expect(late.roomsEnded).toBe(1)
      expect(await roomRow(db, roomId)).toMatchObject({ status: 'ended', ended_reason: 'no_humans' })

      // A room nobody is in any more is ended by the very next sweep.
      const empty = await startStandaloneRoom(db, owner)
      await db.rpc('room_leave', { room_id: empty.room.id }, owner.as)
      const swept = await db.rpc<{ roomsEnded: number }>('rooms_sweep', {}, 'service')
      expect(swept.roomsEnded).toBe(1)
      expect(await roomRow(db, empty.room.id)).toMatchObject({ status: 'ended', ended_reason: 'empty' })

      // A Human coming back within the grace keeps the room open.
      const kept = await startStandaloneRoom(db, owner)
      const invite2 = await createRoomInvite(db, kept.room.id, owner)
      await createGuestSession(db, await createGuest(db), invite2.token, 'Pat')
      await db.rpc('room_leave', { room_id: kept.room.id }, owner.as)
      await joinRoom(db, kept.room.id, owner, 'camera', 'friends')
      const none = await rpcAt<{ roomsEnded: number }>(db, 'rooms_sweep', {}, 'service', secondsFromNow(300))
      expect(none.roomsEnded).toBe(0)
      await db.rpc('room_end', { room_id: kept.room.id }, owner.as)
    })

    it('a block inside a live room clears the blocked seat; the blocker keeps their room (0360)', async () => {
      const a = await human(db, 'Blocka')
      const b = await human(db, 'Blockb')
      await befriend(db, a, b)
      const started = await startStandaloneRoom(db, a)
      await joinRoom(db, started.room.id, b, 'camera', 'friends')
      await block(db, a, b)
      expect(await participantStatus(db, started.room.id, b.humanId)).toMatchObject({ status: 'removed' })
      expect(await roomRow(db, started.room.id)).toMatchObject({ active_participant_count: 1 })
      await db.expectError(db.rpc('room_get', { room_id: started.room.id }, b.as), 'room_not_found')
      await db.expectError(db.rpc('room_join', { room_id: started.room.id, media_state: 'camera', consent_level: 'friends' }, b.as), 'room_not_found')
      expect((await getRoom(db, started.room.id, a.as)).participants).toHaveLength(1)
      await db.rpc('room_end', { room_id: started.room.id }, a.as)

      // A participant blocking the moderator leaves instead; moderation stays where it was.
      const c = await human(db, 'Blockc')
      const d = await human(db, 'Blockd')
      await befriend(db, c, d)
      const second = await startStandaloneRoom(db, c)
      await joinRoom(db, second.room.id, d, 'camera', 'friends')
      await block(db, d, c)
      expect(await participantStatus(db, second.room.id, d.humanId)).toMatchObject({ status: 'left' })
      expect(await participantStatus(db, second.room.id, c.humanId)).toMatchObject({ status: 'active', role: 'initiator' })
      await db.rpc('room_end', { room_id: second.room.id }, c.as)
    })
  })
})
