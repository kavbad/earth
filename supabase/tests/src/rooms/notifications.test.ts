import { NOTIFICATION_PAYLOAD_SCHEMAS, shouldNotifyLive } from '@earth/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type TestDb } from '../harness'
import {
  addMember,
  befriend,
  block,
  createGroup,
  createGuest,
  createGuestSession,
  createRoomInvite,
  human,
  joinRoom,
  notificationsFor,
  rpcAt,
  secondsFromNow,
  setConversationPrefs,
  startGroupRoom,
  startStandaloneRoom,
  type Human,
} from './fixtures'

async function liveNotifications(db: TestDb, recipient: Human, roomId: string) {
  const all = await notificationsFor(db, recipient)
  return all.filter(
    (n) =>
      ['friend_live', 'multi_live', 'group_live'].includes(n.type) &&
      (n.payload as { roomId?: string }).roomId === roomId,
  )
}

async function cooldown(db: TestDb, recipient: Human, roomId: string) {
  const { rows } = await db.sql.query<{
    sends_in_window: number
    notified_participant_ids: string[]
  }>(
    'select sends_in_window, notified_participant_ids from public.notification_cooldowns where recipient_human_id = $1 and room_id = $2',
    [recipient.humanId, roomId],
  )
  return rows[0] ?? null
}

describe('Live notifications and dedupe (spec §57, §58, §86–§87; ARCHITECTURE §11)', () => {
  let db: TestDb

  beforeAll(async () => {
    db = await createTestDb()
  })

  afterAll(async () => {
    await db.drop()
  })

  it('friends Live: initial once, churn nothing, one extra for a direct friend joining on camera, then nothing', async () => {
    const x = await human(db, 'Xavier')
    const r = await human(db, 'Recipient')
    const y = await human(db, 'Maya')
    const w = await human(db, 'Wanderer')
    const z = await human(db, 'Zed')
    const v = await human(db, 'Viewer')
    for (const other of [r, y, w, z, v]) await befriend(db, x, other)
    for (const other of [y, z, v]) await befriend(db, r, other)

    const started = await startStandaloneRoom(db, x, 'Cooking dinner')
    const roomId = started.room.id
    // Initial notification: friend_live with the spec §86 payload keys.
    let mine = await liveNotifications(db, r, roomId)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({
      type: 'friend_live',
      actor_human_id: x.humanId,
      priority: 'critical_social',
    })
    expect(NOTIFICATION_PAYLOAD_SCHEMAS.friend_live.parse(mine[0]?.payload)).toEqual({
      name: 'Xavier',
      activity: 'Cooking dinner',
    })
    expect(mine[0]?.payload).toMatchObject({
      roomId,
      participantNames: ['Xavier'],
      participantCount: 1,
      contextTitle: null,
      title: 'Xavier is live',
    })
    expect(await cooldown(db, r, roomId)).toEqual({
      sends_in_window: 1,
      notified_participant_ids: [x.humanId],
    })

    // Churn: a viewer joining, a non-friend of R joining on camera, X toggling media → nothing.
    await joinRoom(db, roomId, v, 'watching')
    await joinRoom(db, roomId, w, 'camera', 'friends')
    await db.rpc('room_set_media_state', { room_id: roomId, media_state: 'audio' }, x.as)
    await db.rpc('room_set_media_state', { room_id: roomId, media_state: 'camera' }, x.as)
    expect(await liveNotifications(db, r, roomId)).toHaveLength(1)
    // W's own friends are newly eligible and get their initial notification.
    expect(await liveNotifications(db, w, roomId)).toHaveLength(1)

    // A direct friend of R joining on camera: exactly one more, as multi_live, friends first.
    await joinRoom(db, roomId, y, 'camera', 'friends')
    mine = await liveNotifications(db, r, roomId)
    expect(mine).toHaveLength(2)
    expect(mine[1]).toMatchObject({ type: 'multi_live', actor_human_id: y.humanId })
    expect(NOTIFICATION_PAYLOAD_SCHEMAS.multi_live.parse(mine[1]?.payload)).toEqual({
      names: ['Xavier', 'Maya', 'Wanderer'],
      total: 3,
    })
    expect(mine[1]?.payload).toMatchObject({
      participantNames: ['Xavier', 'Maya', 'Wanderer'],
      participantCount: 3,
      title: 'Xavier, Maya + 1 are live',
    })
    expect(await cooldown(db, r, roomId)).toMatchObject({ sends_in_window: 2 })

    // A third friend joining on camera inside the window: the extra is used up.
    await joinRoom(db, roomId, z, 'camera', 'friends')
    expect(await liveNotifications(db, r, roomId)).toHaveLength(2)
    // The viewer upgrading to audio only: not on camera → nothing.
    await db.rpc(
      'room_set_media_state',
      { room_id: roomId, media_state: 'audio', consent_level: 'friends' },
      v.as,
    )
    expect(await liveNotifications(db, r, roomId)).toHaveLength(2)

    // Once the cooldown elapsed, the next eligible event opens a new window.
    await db.rpc('room_leave', { room_id: roomId }, z.as)
    await rpcAt(
      db,
      'room_join',
      { room_id: roomId, media_state: 'camera', consent_level: 'friends' },
      z.as,
      secondsFromNow(31 * 60),
    )
    expect(await liveNotifications(db, r, roomId)).toHaveLength(3)
    expect(await cooldown(db, r, roomId)).toMatchObject({ sends_in_window: 1 })
    // Participants themselves are never notified; nor is a viewer's friend when the viewer only watched.
    expect(await liveNotifications(db, x, roomId)).toHaveLength(0)
    await db.rpc('room_end', { room_id: roomId }, x.as)
  })

  it('shares the decisions of shouldNotifyLive for the same scenario', async () => {
    const now = new Date('2026-09-03T12:00:00Z')
    const initial = shouldNotifyLive({
      lastSentAt: null,
      notifiedParticipantIds: [],
      joiningParticipant: null,
      now,
    })
    expect(initial.send).toBe(true)
    const churn = shouldNotifyLive({
      lastSentAt: now,
      notifiedParticipantIds: ['x'],
      sendsInWindow: 1,
      joiningParticipant: { humanId: 'w', isDirectFriendOfRecipient: false, mediaState: 'camera' },
      now: new Date(now.getTime() + 60_000),
    })
    expect(churn).toEqual({ send: false, reason: 'not_direct_friend' })
    const extra = shouldNotifyLive({
      lastSentAt: now,
      notifiedParticipantIds: ['x', 'w'],
      sendsInWindow: 1,
      joiningParticipant: { humanId: 'y', isDirectFriendOfRecipient: true, mediaState: 'camera' },
      now: new Date(now.getTime() + 120_000),
    })
    expect(extra.send).toBe(true)
    const third = shouldNotifyLive({
      lastSentAt: new Date(now.getTime() + 120_000),
      notifiedParticipantIds: ['x', 'w', 'y'],
      sendsInWindow: 2,
      joiningParticipant: { humanId: 'z', isDirectFriendOfRecipient: true, mediaState: 'camera' },
      now: new Date(now.getTime() + 180_000),
    })
    expect(third).toEqual({ send: false, reason: 'extra_send_used' })
  })

  it('group_live on room_start goes to members per conversation preferences, never to the initiator or blocked members', async () => {
    const owner = await human(db, 'Owner')
    const all = await human(db, 'All')
    const muted = await human(db, 'Muted')
    const mentions = await human(db, 'Mentions')
    const blocker = await human(db, 'Blocker')
    const group = await createGroup(db, owner, 'Weekend Crew')
    for (const m of [all, muted, mentions, blocker]) await addMember(db, group, m)
    await setConversationPrefs(db, group.conversationId, muted, { muteState: 'muted' })
    await setConversationPrefs(db, group.conversationId, mentions, {
      notificationLevel: 'mentions',
    })
    await block(db, blocker, owner)

    const started = await startGroupRoom(db, owner, group)
    const roomId = started.room.id
    const mine = await liveNotifications(db, all, roomId)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({
      type: 'group_live',
      actor_human_id: owner.humanId,
      priority: 'critical_social',
    })
    expect(NOTIFICATION_PAYLOAD_SCHEMAS.group_live.parse(mine[0]?.payload)).toEqual({
      groupName: 'Weekend Crew',
      names: ['Owner'],
      total: 1,
    })
    expect(mine[0]?.payload).toMatchObject({
      roomId,
      contextTitle: 'Weekend Crew',
      title: 'Weekend Crew is live',
      participantCount: 1,
    })
    expect(await liveNotifications(db, muted, roomId)).toHaveLength(0)
    expect(await liveNotifications(db, mentions, roomId)).toHaveLength(0)
    expect(await liveNotifications(db, blocker, roomId)).toHaveLength(0)
    expect(await liveNotifications(db, owner, roomId)).toHaveLength(0)
    // The second member starting the same room does not re-notify within the cooldown.
    await startGroupRoom(db, all, group)
    await db.rpc(
      'room_set_media_state',
      { room_id: roomId, media_state: 'camera', consent_level: 'group' },
      all.as,
    )
    expect(await liveNotifications(db, muted, roomId)).toHaveLength(0)
    expect(await liveNotifications(db, mentions, roomId)).toHaveLength(0)
    await db.rpc('room_end', { room_id: roomId }, owner.as)
  })

  it('opening a group room to friends notifies friends of consenting publishers, ordered friends first; guests count in names', async () => {
    const owner = await human(db, 'Gowner')
    const member = await human(db, 'Gmember')
    const friendOfMember = await human(db, 'Fom')
    const group = await createGroup(db, owner, 'Crew')
    await addMember(db, group, member)
    await befriend(db, member, friendOfMember)
    const started = await startGroupRoom(db, owner, group)
    const roomId = started.room.id
    await joinRoom(db, roomId, member, 'camera', 'friends')
    const invite = await createRoomInvite(db, roomId, owner)
    await createGuestSession(db, await createGuest(db), invite.token, 'Sam', {
      mediaState: 'camera',
    })
    expect(await liveNotifications(db, friendOfMember, roomId)).toHaveLength(0)
    await db.rpc('room_set_visibility', { room_id: roomId, visibility: 'friends' }, owner.as)
    const mine = await liveNotifications(db, friendOfMember, roomId)
    expect(mine).toHaveLength(1)
    // 0970: Fom is a friend of a publisher, not a member of Crew, so the notification names the
    // people she can see and never the private group (spec §128, §60).
    expect(mine[0]?.type).toBe('multi_live')
    expect(mine[0]?.payload).toMatchObject({
      participantNames: ['Gmember', 'Gowner', 'Sam'],
      participantCount: 3,
      contextTitle: null,
      title: 'Gmember, Gowner + 1 are live',
    })
    await db.rpc('room_end', { room_id: roomId }, owner.as)
  })

  it('0970: a private group never names itself to a non-member the room opened up to; members still get group_live (spec §128)', async () => {
    const owner = await human(db, 'Powner')
    const member = await human(db, 'Pmember')
    const friendOfOwner = await human(db, 'Pfriend')
    const soloFriend = await human(db, 'Psolo')
    const group = await createGroup(db, owner, 'Private Book Club')
    await addMember(db, group, member)
    await befriend(db, owner, friendOfOwner)
    await befriend(db, owner, soloFriend)

    const started = await startGroupRoom(db, owner, group)
    const roomId = started.room.id
    await joinRoom(db, roomId, member, 'camera', 'friends')
    // The friends are not in the group.
    for (const outsider of [friendOfOwner, soloFriend]) {
      const { rows } = await db.sql.query(
        'select 1 from public.group_members where group_id = $1 and human_id = $2',
        [group.groupId, outsider.humanId],
      )
      expect(rows).toHaveLength(0)
      expect(await liveNotifications(db, outsider, roomId)).toHaveLength(0)
    }

    await db.rpc('room_set_visibility', { room_id: roomId, visibility: 'friends' }, owner.as)

    // The member is unchanged: `group_live`, named for the group.
    const theirs = await liveNotifications(db, member, roomId)
    expect(theirs).toHaveLength(1)
    expect(theirs[0]?.type).toBe('group_live')
    expect(theirs[0]?.payload).toMatchObject({
      groupName: 'Private Book Club',
      contextTitle: 'Private Book Club',
      title: 'Private Book Club is live',
    })

    // The non-members get the participant-aware copy, and no row anywhere leaks the group's name.
    for (const outsider of [friendOfOwner, soloFriend]) {
      const mine = await liveNotifications(db, outsider, roomId)
      expect(mine).toHaveLength(1)
      expect(mine[0]?.type).toBe('multi_live')
      expect(mine[0]?.payload).toMatchObject({
        contextTitle: null,
        participantNames: ['Powner', 'Pmember'],
        participantCount: 2,
        title: 'Powner + Pmember are live',
      })
      expect(NOTIFICATION_PAYLOAD_SCHEMAS.multi_live.parse(mine[0]?.payload)).toEqual({
        names: ['Powner', 'Pmember'],
        total: 2,
      })
      expect(JSON.stringify(await notificationsFor(db, outsider))).not.toContain(
        'Private Book Club',
      )
    }
    // Nothing the outsiders can read anywhere in the table carries the group name.
    const { rows: leaked } = await db.sql.query(
      `select 1 from public.notifications
        where recipient_human_id = any($1::uuid[]) and payload::text like '%Private Book Club%'`,
      [[friendOfOwner.humanId, soloFriend.humanId]],
    )
    expect(leaked).toHaveLength(0)

    await db.rpc('room_end', { room_id: roomId }, owner.as)
  })
})
