/**
 * Spec §115 integration flows, one named test per flow, as one story: Xavier claims Earth through a
 * new group, Maya through his invite, Kavon (already on Earth) joins, they chat, Xavier starts the
 * group's room, opens it to Friends with Maya's consent, Sarah joins on camera, a Guest comes in
 * through a link and is removed, Xavier posts to Friends, Ben the stranger sees nothing, a block
 * takes Kavon off every surface, and Live notifications are created once and deduped.
 *
 * Every step drives only what clients drive — public RPCs as a specific caller and the server
 * handlers (`GET /api/feed`, `POST /api/rooms/:id/token`, the claim verification route) through
 * the harness-backed `ServerDeps` — and asserts the observable outcome for every involved role:
 * the actor, the other members, friends, strangers, Guests and Visitors.
 */
import {
  MEDIA_GRANT_TTL_SECONDS,
  NOTIFICATION_PAYLOAD_SCHEMAS,
  RoomVisibilityChangeDtoSchema,
  notificationCopyFromPayload,
  type ClaimStateDto,
  type ConversationSummaryDto,
  type FeedCardDto,
  type LiveCardDto,
  type NotificationDto,
} from '@earth/domain'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { POINTS } from '../geo/fixtures'
import type { RoleSpec } from '../harness'
import {
  claimComplete,
  claimIdentity,
  claimNewHuman,
  claimStart,
  claimState,
  conversations,
  createGuest,
  createPost,
  createWorld,
  directConversation,
  errorCode,
  errorCodeOf,
  existingHuman,
  feedCandidateIds,
  feedCardIds,
  feedPage,
  groupDetail,
  invitePreview,
  joinRoom,
  liveNotificationsFor,
  liveRoomIds,
  makeFriends,
  me,
  mediaGrant,
  mediaToken,
  messagesSince,
  newCredential,
  notifications,
  postDetail,
  postsByAuthor,
  profile,
  readReceipts,
  room,
  search,
  sendText,
  tokenClaims,
  unreadCount,
  verifyThroughServer,
  type ClaimedHuman,
  type Credential,
  type Guest,
  type Human,
  type World,
} from './world'

const isLive = (card: FeedCardDto): card is LiveCardDto => card.kind === 'live'

/** `{title, body}` a stored notification must render to (spec §86 copy, shared with the client). */
function expectedCopy(n: NotificationDto): { title: string; body: string } | null {
  return notificationCopyFromPayload(n.type, n.payload)
}

describe('spec §115 integration flows', () => {
  let world: World
  let visitor: RoleSpec
  let xavierCredential: Credential
  let xavier: Human
  let weekendCrew: {
    groupId: string
    conversationId: string
    inviteToken: string
    inviteUrl: string
  }
  let maya: Human
  let kavon: ClaimedHuman
  let sarah: Human
  let chris: Human
  let ben: Human
  let groupRoomId: string
  let roomInviteToken: string
  let guest: Guest
  let guestSessionId: string
  let friendsPostId: string

  beforeAll(async () => {
    world = await createWorld()
    visitor = 'visitor'
    // Supporting actors already on Earth (not flows under test): a friend of Maya, a friend of
    // Sarah, and Ben, a stranger to everyone.
    sarah = await existingHuman(world, 'Sarah')
    chris = await existingHuman(world, 'Chris')
    ben = await existingHuman(world, 'Ben')
  })

  afterAll(async () => {
    await world.db.drop()
  })

  it('claim Human through new group: a credential becomes an active Human, owner of Weekend Crew, visible only once claimed', async () => {
    xavierCredential = await newCredential(world)
    const { db } = world

    // Before the claim the credential is nobody: claiming state, no Human, no Human features.
    expect(await me(world, xavierCredential.as)).toMatchObject({
      roleKind: 'claiming',
      humanId: null,
      identity: null,
    })
    expect(await errorCode(db.rpc('claim_get', {}, xavierCredential.as))).toBe('claim_not_pending')
    expect(await errorCode(db.rpc('group_create', { name: 'Nope' }, xavierCredential.as))).toBe(
      'not_a_human',
    )

    const started = await claimStart(world, xavierCredential, {
      intent: 'start_group',
      groupLabel: 'Weekend Crew',
    })
    expect(started).toMatchObject({
      status: 'started',
      intent: 'start_group',
      groupLabel: 'Weekend Crew',
      identity: null,
      verification: { status: 'unverified' },
    })
    expect(await me(world, xavierCredential.as)).toMatchObject({
      roleKind: 'claiming',
      humanId: started.humanId,
      humanStatus: 'pending',
      identity: null,
    })
    expect(await errorCode(claimComplete(world, xavierCredential))).toBe('claim_identity_missing')

    const withIdentity = await claimIdentity(world, xavierCredential, 'Xavier', 'xavier')
    expect(withIdentity.status).toBe('identity_set')
    expect(withIdentity.identity).toEqual({
      displayName: 'Xavier',
      handle: 'xavier',
      avatarUrl: null,
    })
    expect(await db.rpc('handle_available', { handle: 'xavier' }, ben.as)).toBe(false)

    // A pending Human is invisible everywhere and can do nothing a Human does.
    expect(await errorCode(profile(world, visitor, 'xavier'))).toBe('not_visible')
    expect(await errorCode(profile(world, ben.as, 'xavier'))).toBe('not_visible')
    expect((await search(world, ben.as, 'Xavier')).people).toEqual([])
    expect(
      await errorCode(db.rpc('room_start', { context_type: 'standalone' }, xavierCredential.as)),
    ).toBe('not_a_human')
    expect(
      await errorCode(
        db.rpc('post_create', { type: 'text', text: 'hi', audience: 'world' }, xavierCredential.as),
      ),
    ).toBe('not_a_human')
    expect(await errorCode(conversations(world, xavierCredential.as))).toBe('not_a_human')
    expect(await errorCode(claimComplete(world, xavierCredential))).toBe('verification_required')

    // Verification runs through the server tier (mock provider) and never activates by itself.
    const session = await verifyThroughServer(world, xavierCredential)
    expect(session).toMatchObject({ status: 'verified', providerUrl: null })
    const verified: ClaimStateDto = await claimState(world, xavierCredential)
    expect(verified).toMatchObject({
      status: 'verified',
      verification: { status: 'verified', sessionId: session.sessionId },
    })
    expect(await me(world, xavierCredential.as)).toMatchObject({
      roleKind: 'claiming',
      humanStatus: 'pending',
      humanPassStatus: 'verified',
    })
    expect(await errorCode(profile(world, ben.as, 'xavier'))).toBe('not_visible')

    // Completion: Human + group + owner membership + conversation, atomically.
    const done = await claimComplete(world, xavierCredential)
    expect(done.humanId).toBe(started.humanId)
    xavier = {
      userId: xavierCredential.userId,
      humanId: done.humanId,
      handle: 'xavier',
      displayName: 'Xavier',
      as: xavierCredential.as,
    }
    expect(await me(world, xavier.as)).toMatchObject({
      roleKind: 'human',
      humanId: xavier.humanId,
      humanStatus: 'active',
      identity: { handle: 'xavier', displayName: 'Xavier' },
    })
    expect((await claimState(world, xavierCredential)).status).toBe('claimed')

    const group = await groupDetail(world, xavier.as, done.groupId)
    expect(group).toMatchObject({
      id: done.groupId,
      name: 'Weekend Crew',
      conversationId: done.conversationId,
      memberCount: 1,
      myRole: 'owner',
      status: 'active',
      activeRoom: null,
    })
    expect(group.members.map((m) => [m.handle, m.role])).toEqual([['xavier', 'owner']])
    const chats = await conversations(world, xavier.as)
    expect(chats.map((c) => [c.id, c.type, c.groupId, c.title])).toEqual([
      [done.conversationId, 'group', done.groupId, 'Weekend Crew'],
    ])

    // Now the whole world sees Xavier; a second Human can never be created silently.
    expect((await profile(world, visitor, 'xavier')).identity).toMatchObject({
      humanId: xavier.humanId,
      handle: 'xavier',
      displayName: 'Xavier',
    })
    expect((await search(world, ben.as, 'Xavier')).people.map((p) => p.humanId)).toEqual([
      xavier.humanId,
    ])
    expect(
      await errorCode(
        db.rpc('claim_start', { intent: 'start_group', group_label: 'Again' }, xavier.as),
      ),
    ).toBe('duplicate_human')
    expect(await errorCode(claimComplete(world, xavierCredential))).toBe('claim_not_pending')

    // "Share group": the owner mints the link; a Visitor previews the group, never its messages.
    const invite = await db.rpc<{ token: string; url: string }>(
      'group_invite_create',
      { group_id: done.groupId },
      xavier.as,
    )
    expect(invite.url).toBe(`https://earth.social/g/${invite.token}`)
    weekendCrew = {
      groupId: done.groupId,
      conversationId: done.conversationId,
      inviteToken: invite.token,
      inviteUrl: invite.url,
    }
    expect(await invitePreview(world, visitor, invite.token)).toEqual({
      groupName: 'Weekend Crew',
      memberCount: 1,
      sampleMembers: [{ displayName: 'Xavier', avatarUrl: null }],
      alreadyMember: false,
      expired: false,
    })
    expect(await errorCode(invitePreview(world, visitor, 'not-a-token'))).toBe('invite_invalid')
  })

  it('claim through existing group invite: Maya becomes a Human and a member of Weekend Crew in one transaction, never a friend', async () => {
    const { db } = world
    const mayaCredential = await newCredential(world)
    expect(
      await errorCode(
        claimStart(world, mayaCredential, { intent: 'join_group', inviteToken: 'nope' }),
      ),
    ).toBe('invite_invalid')
    const started = await claimStart(world, mayaCredential, {
      intent: 'join_group',
      inviteToken: weekendCrew.inviteToken,
    })
    expect(started).toMatchObject({
      status: 'started',
      intent: 'join_group',
      groupLabel: 'Weekend Crew',
    })
    expect(started).not.toHaveProperty('inviteToken')
    await claimIdentity(world, mayaCredential, 'Maya', 'maya')

    // While pending nothing has happened to the group: no membership, no use counted, invisible.
    expect(
      (await groupDetail(world, xavier.as, weekendCrew.groupId)).members.map((m) => m.handle),
    ).toEqual(['xavier'])
    expect((await invitePreview(world, visitor, weekendCrew.inviteToken)).memberCount).toBe(1)
    expect(await errorCode(groupDetail(world, mayaCredential.as, weekendCrew.groupId))).toBe(
      'not_a_human',
    )
    expect(await errorCode(profile(world, xavier.as, 'maya'))).toBe('not_visible')
    expect(await errorCode(claimComplete(world, mayaCredential))).toBe('verification_required')

    await verifyThroughServer(world, mayaCredential)
    const done = await claimComplete(world, mayaCredential)
    expect(done).toEqual({
      humanId: started.humanId,
      groupId: weekendCrew.groupId,
      conversationId: weekendCrew.conversationId,
    })
    maya = {
      userId: mayaCredential.userId,
      humanId: done.humanId,
      handle: 'maya',
      displayName: 'Maya',
      as: mayaCredential.as,
    }

    // Maya: a Human, a member, in the group chat.
    expect(await me(world, maya.as)).toMatchObject({
      roleKind: 'human',
      humanStatus: 'active',
      identity: { handle: 'maya' },
    })
    const asMaya = await groupDetail(world, maya.as, weekendCrew.groupId)
    expect(asMaya).toMatchObject({ myRole: 'member', memberCount: 2 })
    expect(asMaya.members.map((m) => [m.handle, m.role, m.isFriend])).toEqual([
      ['xavier', 'owner', false],
      ['maya', 'member', false],
    ])
    expect((await conversations(world, maya.as)).map((c) => c.id)).toEqual([
      weekendCrew.conversationId,
    ])

    // Xavier: sees the new member and the "Maya joined" line, and Maya is a member, not a friend.
    const asXavier = await groupDetail(world, xavier.as, weekendCrew.groupId)
    expect(asXavier.members.map((m) => [m.handle, m.isFriend])).toEqual([
      ['xavier', false],
      ['maya', false],
    ])
    const joined = (await messagesSince(world, xavier.as, weekendCrew.conversationId)).messages
    expect(joined.map((m) => [m.type, m.text, m.senderHumanId, m.payload['kind']])).toEqual([
      ['system', 'Maya joined', maya.humanId, 'member_joined'],
    ])
    const mayaSeenByXavier = await profile(world, xavier.as, 'maya')
    expect(mayaSeenByXavier).toMatchObject({
      relationship: { isFriend: false, friendRequest: 'none' },
      sharedGroupCount: 1,
      counts: { friends: 0 },
    })

    // Visitors and Maya herself: the invite now previews two members / already a member.
    expect(await invitePreview(world, visitor, weekendCrew.inviteToken)).toMatchObject({
      memberCount: 2,
      alreadyMember: false,
    })
    expect(await invitePreview(world, maya.as, weekendCrew.inviteToken)).toMatchObject({
      memberCount: 2,
      alreadyMember: true,
    })
    expect((await search(world, ben.as, 'Maya')).people.map((p) => p.humanId)).toEqual([
      maya.humanId,
    ])
    // The same credential cannot claim a second Human.
    expect(
      await errorCode(
        db.rpc(
          'claim_start',
          { intent: 'join_group', invite_token: weekendCrew.inviteToken },
          maya.as,
        ),
      ),
    ).toBe('duplicate_human')
  })

  it('existing Human joins group: Kavon (owner of College) joins Weekend Crew through the link as his second group', async () => {
    const { db } = world
    kavon = await claimNewHuman(world, {
      displayName: 'Kavon',
      handle: 'kavon',
      groupLabel: 'College',
    })
    expect((await groupDetail(world, kavon.as, kavon.groupId)).name).toBe('College')
    expect(await invitePreview(world, kavon.as, weekendCrew.inviteToken)).toMatchObject({
      groupName: 'Weekend Crew',
      memberCount: 2,
      alreadyMember: false,
    })

    const join = await db.rpc('group_invite_join', { token: weekendCrew.inviteToken }, kavon.as)
    expect(join).toEqual({
      groupId: weekendCrew.groupId,
      conversationId: weekendCrew.conversationId,
      alreadyMember: false,
      isSecondGroup: true,
    })
    // Joining again is a no-op (no second "joined" line, no second use).
    expect(
      await db.rpc('group_invite_join', { token: weekendCrew.inviteToken }, kavon.as),
    ).toMatchObject({ alreadyMember: true })

    // Kavon: member of both groups, both chats listed, sees the group's history from his join on.
    expect(await groupDetail(world, kavon.as, weekendCrew.groupId)).toMatchObject({
      myRole: 'member',
      memberCount: 3,
    })
    expect((await conversations(world, kavon.as)).map((c) => c.groupId).sort()).toEqual(
      [kavon.groupId, weekendCrew.groupId].sort(),
    )
    // Xavier and Maya: three members, none of them friends; exactly one "Kavon joined" line.
    for (const member of [xavier, maya]) {
      const detail = await groupDetail(world, member.as, weekendCrew.groupId)
      expect(detail.members.map((m) => [m.handle, m.isFriend])).toEqual([
        ['xavier', false],
        ['maya', false],
        ['kavon', false],
      ])
    }
    const lines = (await messagesSince(world, maya.as, weekendCrew.conversationId)).messages.filter(
      (m) => m.type === 'system',
    )
    expect(lines.map((m) => m.text)).toEqual(['Maya joined', 'Kavon joined'])
    expect(await profile(world, kavon.as, 'xavier')).toMatchObject({
      relationship: { isFriend: false },
      sharedGroupCount: 1,
    })
    expect((await profile(world, xavier.as, 'kavon')).counts.friends).toBe(0)
    // Visitors, strangers, Guests: the preview counts three; the group itself stays closed.
    expect((await invitePreview(world, visitor, weekendCrew.inviteToken)).memberCount).toBe(3)
    expect(await errorCode(groupDetail(world, ben.as, weekendCrew.groupId))).toBe('not_a_member')
    expect(await errorCode(groupDetail(world, visitor, weekendCrew.groupId))).toBe(
      'not_authenticated',
    )
    const stray = await createGuest(db)
    expect(
      await errorCode(db.rpc('group_invite_join', { token: weekendCrew.inviteToken }, stray.as)),
    ).toBe('not_a_human')
    expect(
      await errorCode(db.rpc('group_invite_join', { token: weekendCrew.inviteToken }, visitor)),
    ).toBe('not_authenticated')
  })

  it('send/receive message: a DM and a group message reach the other members through messages_since, with unread, notifications and read receipts', async () => {
    const { db } = world
    // Direct: Xavier opens the DM (idempotent), Maya sees it listed.
    const dm = await directConversation(world, xavier.as, maya.humanId)
    expect(dm).toMatchObject({
      type: 'direct',
      groupId: null,
      title: 'Maya',
      unreadCount: 0,
      lastMessage: null,
    })
    expect((await directConversation(world, maya.as, xavier.humanId)).id).toBe(dm.id)
    expect((await conversations(world, maya.as)).map((c) => c.id)).toContain(dm.id)

    const clientId = randomUUID()
    const sent = await sendText(world, xavier.as, dm.id, 'hi Maya', clientId)
    expect(sent).toMatchObject({
      conversationId: dm.id,
      senderHumanId: xavier.humanId,
      type: 'text',
      text: 'hi Maya',
      clientId,
      reactions: [],
    })
    // A retry with the same client id is the same message.
    expect((await sendText(world, xavier.as, dm.id, 'hi Maya', clientId)).id).toBe(sent.id)

    // Maya receives it: polling delivery, unread count, preview, a direct_message notification.
    const delivered = await messagesSince(world, maya.as, dm.id)
    expect(delivered.messages.map((m) => [m.id, m.text])).toEqual([[sent.id, 'hi Maya']])
    const mayaDm = (await conversations(world, maya.as)).find(
      (c) => c.id === dm.id,
    ) as ConversationSummaryDto
    expect(mayaDm).toMatchObject({
      unreadCount: 1,
      title: 'Xavier',
      lastMessage: { id: sent.id, senderDisplayName: 'Xavier', text: 'hi Maya' },
    })
    const dmNotification = (await notifications(world, maya.as)).find(
      (n) => n.type === 'direct_message' && n.objectId === sent.id,
    )
    expect(dmNotification).toMatchObject({
      actorHumanId: xavier.humanId,
      actorHandle: 'xavier',
      priority: 'high',
      readAt: null,
    })
    expect(NOTIFICATION_PAYLOAD_SCHEMAS.direct_message.parse(dmNotification?.payload)).toEqual({
      senderName: 'Xavier',
      preview: 'hi Maya',
    })
    expect({ title: dmNotification?.title, body: dmNotification?.body }).toEqual(
      expectedCopy(dmNotification as NotificationDto),
    )

    // Maya reads and replies; Xavier sees the receipt and only the new message after his own.
    await db.rpc('conversation_mark_read', { conversation_id: dm.id, message_id: sent.id }, maya.as)
    expect((await conversations(world, maya.as)).find((c) => c.id === dm.id)?.unreadCount).toBe(0)
    expect(
      (await readReceipts(world, xavier.as, dm.id)).find((r) => r.humanId === maya.humanId)
        ?.lastReadMessageId,
    ).toBe(sent.id)
    const reply = await sendText(world, maya.as, dm.id, 'hi Xavier')
    expect(
      (await messagesSince(world, xavier.as, dm.id, sent.id)).messages.map((m) => m.id),
    ).toEqual([reply.id])
    expect((await messagesSince(world, maya.as, dm.id, sent.id)).messages.map((m) => m.id)).toEqual(
      [reply.id],
    )
    expect((await conversations(world, xavier.as)).find((c) => c.id === dm.id)).toMatchObject({
      unreadCount: 1,
      lastMessage: { id: reply.id },
    })
    // A reaction travels the same way.
    await db.rpc('message_reaction_toggle', { message_id: sent.id, reaction: '❤️' }, maya.as)
    const reacted = (await messagesSince(world, xavier.as, dm.id)).messages.find(
      (m) => m.id === sent.id,
    )
    expect(reacted?.reactions).toEqual([{ reaction: '❤️', count: 1, reactedByMe: false }])

    // Nobody else: a groupmate, a stranger, a Guest, a Visitor.
    expect(await errorCode(messagesSince(world, kavon.as, dm.id))).toBe('conversation_not_found')
    expect(await errorCode(messagesSince(world, ben.as, dm.id))).toBe('conversation_not_found')
    expect(await errorCode(sendText(world, ben.as, dm.id, 'intruder'))).toBe(
      'conversation_not_found',
    )
    expect(await errorCode(messagesSince(world, (await createGuest(db)).as, dm.id))).toBe(
      'not_a_human',
    )
    expect(await errorCode(messagesSince(world, visitor, dm.id))).toBe('not_authenticated')
    expect((await conversations(world, kavon.as)).map((c) => c.id)).not.toContain(dm.id)

    // Group: one send, every other member receives it and is notified; the sender is not.
    const last =
      (await messagesSince(world, kavon.as, weekendCrew.conversationId)).messages.at(-1)?.id ?? null
    const groupMessage = await sendText(
      world,
      xavier.as,
      weekendCrew.conversationId,
      'Welcome to Earth',
    )
    for (const member of [maya, kavon]) {
      expect(
        (await messagesSince(world, member.as, weekendCrew.conversationId, last)).messages.map(
          (m) => m.id,
        ),
      ).toEqual([groupMessage.id])
      expect(
        (await conversations(world, member.as)).find((c) => c.id === weekendCrew.conversationId)
          ?.lastMessage,
      ).toMatchObject({ id: groupMessage.id, text: 'Welcome to Earth' })
      const notified = (await notifications(world, member.as)).find(
        (n) => n.type === 'group_message' && n.objectId === groupMessage.id,
      )
      expect(notified).toMatchObject({ actorHumanId: xavier.humanId })
      expect(NOTIFICATION_PAYLOAD_SCHEMAS.group_message.parse(notified?.payload)).toEqual({
        groupName: 'Weekend Crew',
        senderName: 'Xavier',
        preview: 'Welcome to Earth',
      })
    }
    expect(
      (await notifications(world, xavier.as)).filter((n) => n.objectId === groupMessage.id),
    ).toEqual([])
    expect(await errorCode(messagesSince(world, ben.as, weekendCrew.conversationId))).toBe(
      'conversation_not_found',
    )
  })

  it('start group room: the group has one active room, members see it on the chat and are notified once, outsiders see nothing', async () => {
    const { db } = world
    const started = await db.rpc<{ room: { id: string }; created: boolean }>(
      'room_start',
      { context_type: 'group', context_id: weekendCrew.groupId, title: 'Cooking dinner' },
      xavier.as,
    )
    expect(started.created).toBe(true)
    groupRoomId = started.room.id
    const asXavier = await room(world, xavier.as, groupRoomId)
    expect(asXavier).toMatchObject({
      contextType: 'group',
      contextId: weekendCrew.groupId,
      visibility: 'group',
      joinPolicy: 'group',
      status: 'active',
      contextTitle: 'Weekend Crew',
      pendingVisibility: null,
    })
    expect(asXavier.myParticipant).toMatchObject({
      humanId: xavier.humanId,
      role: 'initiator',
      mediaState: 'camera',
      status: 'active',
      audienceConsentLevel: 'group',
      relationToViewer: 'self',
    })

    // Members: the group and the chat point at the room, the chat shows the system line, one group_live each.
    for (const member of [maya, kavon]) {
      expect((await groupDetail(world, member.as, weekendCrew.groupId)).activeRoom).toEqual({
        roomId: groupRoomId,
        participantCount: 1,
      })
      expect(
        (await conversations(world, member.as)).find((c) => c.id === weekendCrew.conversationId)
          ?.activeRoom,
      ).toEqual({ roomId: groupRoomId, participantCount: 1 })
      const seen = await room(world, member.as, groupRoomId)
      expect(seen.participants.map((p) => [p.humanId, p.mediaState, p.relationToViewer])).toEqual([
        [xavier.humanId, 'camera', 'shared_group'],
      ])
      expect(seen.myParticipant).toBeNull()
      expect(seen).toMatchObject({ canJoinAudio: true, canJoinCamera: true, joinReason: null })
      const live = await liveNotificationsFor(world, member.as, groupRoomId)
      expect(live.map((n) => n.type)).toEqual(['group_live'])
      expect(live[0]).toMatchObject({ actorHumanId: xavier.humanId, priority: 'critical_social' })
      expect(NOTIFICATION_PAYLOAD_SCHEMAS.group_live.parse(live[0]?.payload)).toEqual({
        groupName: 'Weekend Crew',
        names: ['Xavier'],
        total: 1,
      })
      expect({ title: live[0]?.title, body: live[0]?.body }).toEqual(
        expectedCopy(live[0] as NotificationDto),
      )
      expect(live[0]?.title).toBe('Weekend Crew is live')
    }
    const line = (await messagesSince(world, maya.as, weekendCrew.conversationId)).messages
      .filter((m) => m.type === 'system')
      .at(-1)
    expect(line).toMatchObject({ text: 'Xavier started a video', senderHumanId: xavier.humanId })
    expect(await liveNotificationsFor(world, xavier.as, groupRoomId)).toEqual([])

    // A second member "starting" the room joins the existing one as a viewer and re-notifies nobody.
    const again = await db.rpc<{ room: { id: string; participants: unknown[] }; created: boolean }>(
      'room_start',
      { context_type: 'group', context_id: weekendCrew.groupId },
      kavon.as,
    )
    expect(again).toMatchObject({ created: false, room: { id: groupRoomId } })
    expect((await room(world, kavon.as, groupRoomId)).myParticipant).toMatchObject({
      role: 'viewer',
      mediaState: 'watching',
      status: 'active',
    })
    expect((await liveNotificationsFor(world, maya.as, groupRoomId)).map((n) => n.type)).toEqual([
      'group_live',
    ])
    expect((await groupDetail(world, maya.as, weekendCrew.groupId)).activeRoom).toEqual({
      roomId: groupRoomId,
      participantCount: 2,
    })

    // Outsiders: a stranger, Maya's friend-to-be, Visitors and Guests see no room at all.
    for (const outsider of [ben, sarah]) {
      expect(await errorCode(room(world, outsider.as, groupRoomId))).toBe('room_not_found')
      expect(
        await errorCode(
          db.rpc(
            'room_start',
            { context_type: 'group', context_id: weekendCrew.groupId },
            outsider.as,
          ),
        ),
      ).toBe('not_a_member')
      expect(await liveRoomIds(world, outsider.as, 'friends')).toEqual([])
      expect((await feedPage(world, outsider.as, 'friends')).cards.filter(isLive)).toEqual([])
    }
    expect(await errorCode(room(world, visitor, groupRoomId))).toBe('room_not_found')
    expect(await liveRoomIds(world, visitor, 'world')).toEqual([])
    expect(
      await errorCode(
        db.rpc('room_start', { context_type: 'group', context_id: weekendCrew.groupId }, visitor),
      ),
    ).toBe('not_authenticated')
    expect(
      await errorCode(
        db.rpc(
          'room_start',
          { context_type: 'group', context_id: weekendCrew.groupId },
          (await createGuest(db)).as,
        ),
      ),
    ).toBe('not_a_human')
  })

  it('expand to Friends (with consent): the widening waits for Maya on camera, then her friend Sarah discovers the Live', async () => {
    const { db } = world
    // Sarah and Maya become friends the product way (request + accept, both notified).
    await makeFriends(world, sarah, maya)
    expect((await profile(world, sarah.as, 'maya')).relationship.isFriend).toBe(true)
    expect(
      (await notifications(world, maya.as)).some(
        (n) => n.type === 'friend_request' && n.actorHumanId === sarah.humanId,
      ),
    ).toBe(true)
    expect(
      (await notifications(world, sarah.as)).some(
        (n) => n.type === 'friend_accepted' && n.actorHumanId === maya.humanId,
      ),
    ).toBe(true)
    // Friendship alone does not reach a group room.
    expect(await liveRoomIds(world, sarah.as, 'friends')).toEqual([])
    expect(await errorCode(room(world, sarah.as, groupRoomId))).toBe('room_not_found')

    // Maya joins on camera, consenting to the group; Xavier asks for Friends.
    const mayaSeat = (await joinRoom(world, maya.as, groupRoomId, 'camera', 'group')).myParticipant
    expect(mayaSeat).toMatchObject({
      mediaState: 'camera',
      role: 'participant',
      audienceConsentLevel: 'group',
    })
    expect(
      await errorCode(
        db.rpc('room_set_visibility', { room_id: groupRoomId, visibility: 'friends' }, maya.as),
      ),
    ).toBe('not_a_moderator')
    const pending = RoomVisibilityChangeDtoSchema.parse(
      await db.rpc(
        'room_set_visibility',
        { room_id: groupRoomId, visibility: 'friends' },
        xavier.as,
      ),
    )
    expect(pending).toEqual({
      applied: false,
      visibility: 'group',
      pendingVisibility: 'friends',
      pendingParticipantIds: [mayaSeat?.id],
    })

    // Pending is not open: every role still sees a group room; Maya sees what is asked of her.
    expect(await room(world, maya.as, groupRoomId)).toMatchObject({
      visibility: 'group',
      pendingVisibility: 'friends',
    })
    expect(await room(world, kavon.as, groupRoomId)).toMatchObject({
      visibility: 'group',
      pendingVisibility: 'friends',
    })
    expect(await liveRoomIds(world, sarah.as, 'friends')).toEqual([])
    expect(await errorCode(room(world, sarah.as, groupRoomId))).toBe('room_not_found')
    expect(await liveNotificationsFor(world, sarah.as, groupRoomId)).toEqual([])
    // A consent below the request changes nothing; consenting to Friends applies it.
    expect(
      RoomVisibilityChangeDtoSchema.parse(
        await db.rpc('room_consent', { room_id: groupRoomId, level: 'group' }, maya.as),
      ).applied,
    ).toBe(false)
    const applied = RoomVisibilityChangeDtoSchema.parse(
      await db.rpc('room_consent', { room_id: groupRoomId, level: 'friends' }, maya.as),
    )
    expect(applied).toEqual({
      applied: true,
      visibility: 'friends',
      pendingVisibility: null,
      pendingParticipantIds: [],
    })

    // Members see the wider room; Sarah (friend of a consenting camera participant) discovers it.
    for (const member of [xavier, maya, kavon]) {
      expect(await room(world, member.as, groupRoomId)).toMatchObject({
        visibility: 'friends',
        joinPolicy: 'friends',
        pendingVisibility: null,
      })
    }
    expect(await liveRoomIds(world, sarah.as, 'friends')).toEqual([groupRoomId])
    const asSarah = await room(world, sarah.as, groupRoomId)
    expect(asSarah.participants.map((p) => [p.humanId, p.relationToViewer])).toEqual([
      [xavier.humanId, 'other'],
      [maya.humanId, 'friend'],
    ])
    expect(asSarah.myParticipant).toBeNull()
    // 0999: the room screen is discovery too — it never names the group Sarah is not in (§128).
    expect(asSarah.contextTitle).toBeNull()
    // 0998: Sarah is not in Weekend Crew, so discovery never tells her its name — the card is
    // named for her by the people she can see, friend first (spec §60, SCREEN 13, §128).
    const sarahFeed = await feedPage(world, sarah.as, 'friends')
    expect(sarahFeed.cards.filter(isLive)).toHaveLength(1)
    expect(sarahFeed.cards.filter(isLive)[0]).toMatchObject({
      roomId: groupRoomId,
      title: 'Maya + Xavier are live',
      contextTitle: null,
      visibility: 'friends',
      participantNames: ['Maya', 'Xavier'],
      participantCount: 2,
    })
    // 0970: her notification is named the same way, and never carries the group's name (spec §128).
    const sarahLive = await liveNotificationsFor(world, sarah.as, groupRoomId)
    expect(sarahLive.map((n) => n.type)).toEqual(['multi_live'])
    expect(sarahLive[0]?.payload).toMatchObject({
      contextTitle: null,
      title: 'Maya + Xavier are live',
      participantNames: ['Maya', 'Xavier'],
    })

    // Still nothing for strangers, for a friend of someone who is not publishing, for Visitors: friends is not World.
    await makeFriends(world, chris, sarah)
    expect(await liveRoomIds(world, ben.as, 'friends')).toEqual([])
    expect(await errorCode(room(world, ben.as, groupRoomId))).toBe('room_not_found')
    expect(await liveRoomIds(world, chris.as, 'friends')).toEqual([])
    expect(await errorCode(room(world, chris.as, groupRoomId))).toBe('room_not_found')
    expect(await liveRoomIds(world, visitor, 'world')).toEqual([])
    expect(await errorCode(room(world, visitor, groupRoomId))).toBe('room_not_found')
    expect((await feedPage(world, null, 'world')).cards.filter(isLive)).toEqual([])
  })

  it('participant joins camera with consent: Sarah must acknowledge Friends, then publishes with a token that is exactly her grant', async () => {
    const { db } = world
    // Camera without covering consent is refused; the affordance says the seat is otherwise hers.
    expect(await errorCode(joinRoom(world, sarah.as, groupRoomId, 'camera', 'group'))).toBe(
      'consent_required',
    )
    expect(await errorCode(joinRoom(world, sarah.as, groupRoomId, 'audio', 'invited'))).toBe(
      'consent_required',
    )
    expect(await room(world, sarah.as, groupRoomId)).toMatchObject({
      canJoinCamera: true,
      canJoinAudio: true,
      joinReason: null,
    })
    expect(await errorCode(mediaGrant(world, sarah.as, groupRoomId))).toBe('not_in_room')

    const joined = await joinRoom(world, sarah.as, groupRoomId, 'camera', 'friends')
    expect(joined.myParticipant).toMatchObject({
      humanId: sarah.humanId,
      mediaState: 'camera',
      role: 'participant',
      status: 'active',
      audienceConsentLevel: 'friends',
      relationToViewer: 'self',
    })
    // The grant and the LiveKit token the server mints from it, as the caller.
    const grant = await mediaGrant(world, sarah.as, groupRoomId)
    expect(grant).toEqual({
      livekitRoom: groupRoomId,
      identity: `h:${sarah.humanId}`,
      name: 'Sarah',
      role: 'participant',
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      ttlSeconds: MEDIA_GRANT_TTL_SECONDS,
    })
    const claims = await tokenClaims(await mediaToken(world, sarah.as, groupRoomId))
    expect(claims.sub).toBe(`h:${sarah.humanId}`)
    expect(claims.name).toBe('Sarah')
    expect(claims.video).toMatchObject({
      room: groupRoomId,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      roomAdmin: false,
    })
    expect(JSON.parse(claims.metadata ?? '{}')).toEqual({ isGuest: false, role: 'participant' })
    expect(world.ctx.callsTo('room_media_grant').at(-1)).toMatchObject({
      as: sarah.as,
      args: { room_id: groupRoomId },
    })

    // Everyone in the room sees Sarah on camera; the group chat pointer counts her.
    for (const insider of [xavier, maya, kavon]) {
      const seen = await room(world, insider.as, groupRoomId)
      expect(seen.participants.find((p) => p.humanId === sarah.humanId)).toMatchObject({
        mediaState: 'camera',
        status: 'active',
      })
    }
    expect((await groupDetail(world, kavon.as, weekendCrew.groupId)).activeRoom).toEqual({
      roomId: groupRoomId,
      participantCount: 4,
    })
    // A watching viewer gets a token that cannot publish; the initiator's says moderator rights are not in the token either.
    const viewerClaims = await tokenClaims(await mediaToken(world, kavon.as, groupRoomId))
    expect(viewerClaims.video).toMatchObject({
      room: groupRoomId,
      canPublish: false,
      canSubscribe: true,
    })
    expect(JSON.parse(viewerClaims.metadata ?? '{}')).toEqual({ isGuest: false, role: 'viewer' })
    // Sarah's own friend Chris now reaches the room through her (spec §58); Ben and Visitors do not.
    expect(await liveRoomIds(world, chris.as, 'friends')).toEqual([groupRoomId])
    expect(
      (await room(world, chris.as, groupRoomId)).participants.find(
        (p) => p.humanId === sarah.humanId,
      )?.relationToViewer,
    ).toBe('friend')
    const outsider = await mediaToken(world, ben.as, groupRoomId)
    expect([outsider.status, errorCodeOf(outsider)]).toEqual([403, 'not_in_room'])
    const anonymous = await mediaToken(world, undefined, groupRoomId)
    expect([anonymous.status, errorCodeOf(anonymous)]).toEqual([401, 'not_authenticated'])
    expect(
      await errorCode(
        db.rpc('room_set_media_state', { room_id: groupRoomId, media_state: 'camera' }, ben.as),
      ),
    ).toBe('not_in_room')
  })

  it('Guest joins via link: an anonymous browser session enters through the invite, gets a g: token, and is not a Human', async () => {
    const { db } = world
    const invite = await db.rpc<{ token: string; url: string; expiresAt: string }>(
      'room_invite_create',
      { room_id: groupRoomId },
      xavier.as,
    )
    expect(invite.url).toBe(`https://earth.social/live/${invite.token}`)
    roomInviteToken = invite.token
    // The link previews publishers only (Kavon watches), for anyone.
    const preview = await db.rpc<{
      roomId: string
      contextTitle: string | null
      visibility: string
      participants: Array<{ displayName: string; isGuest: boolean }>
      invitedByDisplayName: string | null
      guestsAllowed: boolean
      ended: boolean
    }>('room_invite_preview', { token: invite.token }, visitor)
    expect(preview).toMatchObject({
      roomId: groupRoomId,
      contextTitle: 'Weekend Crew',
      visibility: 'friends',
      invitedByDisplayName: 'Xavier',
      guestsAllowed: true,
      ended: false,
    })
    expect(preview.participants.map((p) => p.displayName).sort()).toEqual([
      'Maya',
      'Sarah',
      'Xavier',
    ])
    expect(preview.participants.every((p) => !p.isGuest)).toBe(true)

    // Only an anonymous credential can become a Guest.
    expect(
      await errorCode(
        db.rpc('guest_session_create', { token: invite.token, display_name: 'Sam' }, visitor),
      ),
    ).toBe('not_authenticated')
    expect(
      await errorCode(
        db.rpc('guest_session_create', { token: invite.token, display_name: 'Sam' }, ben.as),
      ),
    ).toBe('forbidden')
    guest = await createGuest(db)
    const session = await db.rpc<{
      guestSessionId: string
      roomId: string
      displayName: string
      sessionSecret: string
    }>(
      'guest_session_create',
      { token: invite.token, display_name: 'Sam', device_fingerprint_hash: 'fp-sam-device' },
      guest.as,
    )
    expect(session).toMatchObject({ roomId: groupRoomId, displayName: 'Sam' })
    expect(session.sessionSecret.length).toBeGreaterThan(20)
    guestSessionId = session.guestSessionId
    expect(await me(world, guest.as)).toMatchObject({
      roleKind: 'guest',
      humanId: null,
      identity: null,
    })

    // The Guest is in the room and can publish: grant and token carry the g: identity.
    const asGuest = await room(world, guest.as, groupRoomId)
    expect(asGuest.myParticipant).toMatchObject({
      guestSessionId,
      humanId: null,
      isGuest: true,
      displayName: 'Sam',
      mediaState: 'audio',
      role: 'participant',
      status: 'active',
      audienceConsentLevel: 'friends',
      relationToViewer: null,
    })
    expect(asGuest.participants.every((p) => p.relationToViewer === null || p.isGuest)).toBe(true)
    expect(await mediaGrant(world, guest.as, groupRoomId)).toEqual({
      livekitRoom: groupRoomId,
      identity: `g:${guestSessionId}`,
      name: 'Sam',
      role: 'participant',
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      ttlSeconds: MEDIA_GRANT_TTL_SECONDS,
    })
    const claims = await tokenClaims(await mediaToken(world, guest.as, groupRoomId))
    expect(claims.sub).toBe(`g:${guestSessionId}`)
    expect(claims.name).toBe('Sam')
    expect(claims.video).toMatchObject({ room: groupRoomId, canPublish: true, canSubscribe: true })
    expect(JSON.parse(claims.metadata ?? '{}')).toEqual({ isGuest: true, role: 'participant' })

    // Humans in the room see Sam as a Guest; the Guest is not a Human anywhere else.
    for (const insider of [xavier, maya, sarah, kavon]) {
      const seen = await room(world, insider.as, groupRoomId)
      expect(seen.participants.find((p) => p.guestSessionId === guestSessionId)).toMatchObject({
        isGuest: true,
        displayName: 'Sam',
        humanId: null,
        mediaState: 'audio',
        relationToViewer: null,
      })
    }
    expect(
      await errorCode(
        db.rpc('claim_start', { intent: 'start_group', group_label: 'Nope' }, guest.as),
      ),
    ).toBe('guest_not_allowed')
    expect(await errorCode(liveRoomIds(world, guest.as, 'friends'))).toBe('guest_not_allowed')
    expect(
      await errorCode(
        db.rpc('room_set_visibility', { room_id: groupRoomId, visibility: 'world' }, guest.as),
      ),
    ).toBe('guest_not_allowed')
    expect(await errorCode(groupDetail(world, guest.as, weekendCrew.groupId))).toBe('not_a_human')
    expect(await errorCode(messagesSince(world, guest.as, weekendCrew.conversationId))).toBe(
      'not_a_human',
    )
    expect(
      await errorCode(
        db.rpc('post_create', { type: 'text', text: 'hi', audience: 'world' }, guest.as),
      ),
    ).toBe('not_a_human')
    expect(await errorCode(profile(world, ben.as, 'sam'))).toBe('not_visible')
    expect((await search(world, ben.as, 'Sam')).people).toEqual([])
    expect((await groupDetail(world, xavier.as, weekendCrew.groupId)).memberCount).toBe(3)
  })

  it('moderator removes Guest: only a moderator can, the seat is gone, and the blocked fingerprint cannot come back', async () => {
    const { db } = world
    const seat = (await room(world, xavier.as, groupRoomId)).participants.find(
      (p) => p.guestSessionId === guestSessionId,
    )
    expect(seat).toBeDefined()
    expect(
      await errorCode(
        db.rpc(
          'room_remove_participant',
          { room_id: groupRoomId, participant_id: seat?.id, block_from_room: true },
          maya.as,
        ),
      ),
    ).toBe('not_a_moderator')
    expect(
      await errorCode(
        db.rpc(
          'room_remove_participant',
          { room_id: groupRoomId, participant_id: seat?.id, block_from_room: true },
          ben.as,
        ),
      ),
    ).toBe('room_not_found')
    const removed = await db.rpc<{ participants: Array<{ guestSessionId: string | null }> }>(
      'room_remove_participant',
      { room_id: groupRoomId, participant_id: seat?.id, block_from_room: true },
      xavier.as,
    )
    expect(removed.participants.some((p) => p.guestSessionId === guestSessionId)).toBe(false)

    // The Guest: no room, no grant, no token, no new session with that credential.
    expect(await errorCode(room(world, guest.as, groupRoomId))).toBe('room_not_found')
    expect(await errorCode(mediaGrant(world, guest.as, groupRoomId))).toBe('not_in_room')
    const denied = await mediaToken(world, guest.as, groupRoomId)
    expect([denied.status, errorCodeOf(denied)]).toEqual([403, 'not_in_room'])
    expect(
      await errorCode(
        db.rpc('room_join', { room_id: groupRoomId, media_state: 'audio' }, guest.as),
      ),
    ).toBe('guest_not_allowed')
    expect(
      await errorCode(
        db.rpc('guest_session_create', { token: roomInviteToken, display_name: 'Sam' }, guest.as),
      ),
    ).toBe('blocked')
    // The same device with a fresh credential is refused; a clean device is admitted.
    const sameDevice = await createGuest(db)
    expect(
      await errorCode(
        db.rpc(
          'guest_session_create',
          {
            token: roomInviteToken,
            display_name: 'Sam again',
            device_fingerprint_hash: 'fp-sam-device',
          },
          sameDevice.as,
        ),
      ),
    ).toBe('blocked')
    const cleanDevice = await createGuest(db)
    const pat = await db.rpc<{ guestSessionId: string }>(
      'guest_session_create',
      { token: roomInviteToken, display_name: 'Pat', device_fingerprint_hash: 'fp-pat-device' },
      cleanDevice.as,
    )
    // Everyone inside sees Sam gone and Pat in; the room itself is unchanged for its members.
    for (const insider of [xavier, maya, sarah, kavon]) {
      const seen = await room(world, insider.as, groupRoomId)
      expect(seen.participants.map((p) => p.guestSessionId).filter((id) => id !== null)).toEqual([
        pat.guestSessionId,
      ])
      expect(seen).toMatchObject({ status: 'active', visibility: 'friends' })
    }
    expect((await groupDetail(world, kavon.as, weekendCrew.groupId)).activeRoom).toEqual({
      roomId: groupRoomId,
      participantCount: 5,
    })
    // Pat leaves the story; the room goes on with its Humans.
    await db.rpc('room_leave', { room_id: groupRoomId }, cleanDevice.as)
    expect((await room(world, xavier.as, groupRoomId)).participants.some((p) => p.isGuest)).toBe(
      false,
    )
  })

  it('post Friends: a Friends post reaches friends in post_get, the ranked feed, search and reactions', async () => {
    const { db } = world
    // Kavon and Xavier become friends (member → friend is an explicit step).
    await makeFriends(world, kavon, xavier)
    expect((await profile(world, xavier.as, 'kavon')).relationship.isFriend).toBe(true)
    const view = await createPost(world, xavier.as, {
      text: 'Dinner at ours tonight',
      audience: 'friends',
    })
    expect(view.post).toMatchObject({
      authorHumanId: xavier.humanId,
      audience: 'friends',
      parentPostId: null,
    })
    expect(view.author).toMatchObject({ humanId: xavier.humanId, handle: 'xavier' })
    friendsPostId = view.post.id

    // Kavon (friend): fetch, feed candidates, ranked feed page, search, author page.
    expect(await postDetail(world, kavon.as, friendsPostId)).toMatchObject({
      post: { id: friendsPostId, audience: 'friends' },
      replies: [],
      myReaction: null,
    })
    expect(await feedCandidateIds(world, kavon.as, 'friends')).toContain(friendsPostId)
    const page = await feedPage(world, kavon.as, 'friends')
    const card = page.cards.find((c) => c.id === friendsPostId)
    expect(card).toMatchObject({
      kind: 'post',
      post: { id: friendsPostId, text: 'Dinner at ours tonight' },
      author: { handle: 'xavier' },
    })
    expect(world.ctx.callsTo('feed_candidates').at(-1)).toMatchObject({
      as: kavon.as,
      args: { scope: 'friends' },
    })
    expect((await search(world, kavon.as, 'Dinner')).posts.map((p) => p.post.id)).toEqual([
      friendsPostId,
    ])
    expect(await postsByAuthor(world, kavon.as, 'xavier')).toEqual([friendsPostId])
    // Reacting and replying stay within the audience.
    await db.rpc('post_reaction_set', { post_id: friendsPostId, reaction_type: 'like' }, kavon.as)
    expect(await postDetail(world, kavon.as, friendsPostId)).toMatchObject({
      reactionCount: 1,
      myReaction: 'like',
    })
    const reply = await createPost(world, kavon.as, {
      text: 'Count me in',
      audience: 'world',
      parentPostId: friendsPostId,
    })
    expect(reply.post).toMatchObject({
      parentPostId: friendsPostId,
      rootPostId: friendsPostId,
      audience: 'friends',
    })
    // The author sees the reaction and the reply too.
    const asAuthor = await postDetail(world, xavier.as, friendsPostId)
    expect(asAuthor).toMatchObject({ reactionCount: 1, replyCount: 1 })
    expect(asAuthor.replies.map((r) => r.post.id)).toEqual([reply.post.id])
    expect(await postsByAuthor(world, xavier.as, 'xavier')).toEqual([friendsPostId])
  })

  it('ensure stranger cannot view Friends post: not by fetch, feed, search, author page, follow, membership, Guest or Visitor', async () => {
    const { db } = world
    // Ben, a stranger.
    expect(await errorCode(postDetail(world, ben.as, friendsPostId))).toBe('post_not_found')
    for (const scope of ['friends', 'world'] as const) {
      expect(await feedCandidateIds(world, ben.as, scope)).not.toContain(friendsPostId)
      expect(await feedCardIds(world, ben.as, scope)).not.toContain(friendsPostId)
    }
    expect((await search(world, ben.as, 'Dinner')).posts).toEqual([])
    expect(await postsByAuthor(world, ben.as, 'xavier')).toEqual([])
    expect(
      await errorCode(
        db.rpc('post_reaction_set', { post_id: friendsPostId, reaction_type: 'like' }, ben.as),
      ),
    ).toBe('post_not_found')
    expect(
      await errorCode(
        createPost(world, ben.as, {
          text: 'me too',
          audience: 'world',
          parentPostId: friendsPostId,
        }),
      ),
    ).toBe('post_not_found')
    expect(
      (
        await db.asRole(ben.as, (c) =>
          c.query('select id from public.posts where id = $1', [friendsPostId]),
        )
      ).rowCount,
    ).toBe(0)
    // Following is not friendship: Ben follows Xavier and still sees nothing.
    await db.rpc('follow_set', { target_human_id: xavier.humanId, following: true }, ben.as)
    expect((await profile(world, ben.as, 'xavier')).relationship).toMatchObject({
      isFollowing: true,
      isFriend: false,
    })
    expect(await errorCode(postDetail(world, ben.as, friendsPostId))).toBe('post_not_found')
    expect(await feedCardIds(world, ben.as, 'friends')).not.toContain(friendsPostId)
    // Group membership is not friendship: Maya shares Weekend Crew with Xavier and sees nothing.
    expect(await errorCode(postDetail(world, maya.as, friendsPostId))).toBe('post_not_found')
    expect(await feedCandidateIds(world, maya.as, 'friends')).not.toContain(friendsPostId)
    expect((await search(world, maya.as, 'Dinner')).posts).toEqual([])
    // Guests and Visitors: never a Friends post, not even through the reply.
    const stray = await createGuest(db)
    expect(await errorCode(postDetail(world, stray.as, friendsPostId))).toBe('post_not_found')
    expect(await errorCode(postDetail(world, visitor, friendsPostId))).toBe('post_not_found')
    expect(await feedCardIds(world, null, 'world')).not.toContain(friendsPostId)
    expect((await search(world, visitor, 'Dinner')).posts).toEqual([])
    const replyId = (await postDetail(world, xavier.as, friendsPostId)).replies[0]?.post.id ?? ''
    expect(await errorCode(postDetail(world, ben.as, replyId))).toBe('post_not_found')
    expect(await errorCode(postDetail(world, visitor, replyId))).toBe('post_not_found')
    // A World post by the same author is visible to all of them (the audience, not the author, is the rule).
    const open = await createPost(world, xavier.as, { text: 'Hello from Earth', audience: 'world' })
    expect((await postDetail(world, ben.as, open.post.id)).post.id).toBe(open.post.id)
    expect((await postDetail(world, visitor, open.post.id)).post.id).toBe(open.post.id)
    expect(await feedCardIds(world, null, 'world')).toContain(open.post.id)
    expect(await postsByAuthor(world, ben.as, 'xavier')).toEqual([open.post.id])
  })

  it('block removes eligibility: after Xavier blocks Kavon nothing of either reaches the other — DM, Live, location, notifications, search, feed — while the group survives', async () => {
    const { db } = world
    // Before: every surface really carries Xavier to Kavon (friends since the post flow).
    const dm = await directConversation(world, kavon.as, xavier.humanId)
    const before = await sendText(world, kavon.as, dm.id, 'see you tonight')
    expect((await messagesSince(world, xavier.as, dm.id)).messages.map((m) => m.id)).toContain(
      before.id,
    )
    const walk = await db.rpc<{ room: { id: string } }>(
      'room_start',
      { context_type: 'standalone', context_id: null, title: 'Walk' },
      xavier.as,
    )
    const walkRoomId = walk.room.id
    const share = await db.rpc<{ id: string }>(
      'location_share_create',
      {
        audience_type: 'friend',
        audience_id: kavon.humanId,
        precision: 'precise',
        duration_seconds: 3600,
        lat: POINTS.northBeach.lat,
        lng: POINTS.northBeach.lng,
      },
      xavier.as,
    )
    const kavonWorldPost = (
      await createPost(world, kavon.as, { text: 'Giraffe season', audience: 'world' })
    ).post.id
    const visibleShares = async (as: RoleSpec) =>
      (await db.rpc<Array<{ humanId: string }>>('location_shares_visible', {}, as)).map(
        (s) => s.humanId,
      )
    const fromXavier = async () =>
      (await notifications(world, kavon.as))
        .filter((n) => n.actorHumanId === xavier.humanId)
        .map((n) => n.id)
        .sort()

    expect(await liveRoomIds(world, kavon.as, 'friends')).toEqual(
      expect.arrayContaining([walkRoomId, groupRoomId]),
    )
    expect((await liveNotificationsFor(world, kavon.as, walkRoomId)).map((n) => n.type)).toEqual([
      'friend_live',
    ])
    expect(await visibleShares(kavon.as)).toEqual([xavier.humanId])
    expect(await feedCardIds(world, kavon.as, 'friends')).toContain(friendsPostId)
    expect(
      (await feedPage(world, kavon.as, 'friends')).cards.filter(isLive).map((c) => c.roomId),
    ).toContain(walkRoomId)
    expect((await search(world, kavon.as, 'Xavier')).people.map((p) => p.humanId)).toEqual([
      xavier.humanId,
    ])
    expect(await feedCardIds(world, xavier.as, 'world')).toContain(kavonWorldPost)
    const notificationsBefore = await fromXavier()
    expect(notificationsBefore.length).toBeGreaterThan(0)

    // The block.
    expect(await db.rpc('block_set', { target_human_id: kavon.humanId }, xavier.as)).toMatchObject({
      isBlocked: true,
      isFriend: false,
      isFollowing: false,
    })
    expect(
      (
        await db.rpc<{ blocks: Array<{ blockedHumanId: string }> }>('blocks_list', {}, xavier.as)
      ).blocks.map((b) => b.blockedHumanId),
    ).toEqual([kavon.humanId])

    // DM: neither can message, open or read the direct conversation.
    expect(await errorCode(sendText(world, kavon.as, dm.id, 'let me in'))).toBe('blocked')
    expect(await errorCode(sendText(world, xavier.as, dm.id, 'no'))).toBe('blocked')
    expect(await errorCode(messagesSince(world, kavon.as, dm.id))).toBe('blocked')
    expect(await errorCode(directConversation(world, kavon.as, xavier.humanId))).toBe('blocked')
    expect(await errorCode(directConversation(world, xavier.as, kavon.humanId))).toBe('blocked')
    expect((await conversations(world, kavon.as)).map((c) => c.id)).not.toContain(dm.id)
    // Live discovery: Xavier's Lives vanish for Kavon (list, fetch, join, feed card).
    const kavonLives = await liveRoomIds(world, kavon.as, 'friends')
    expect(kavonLives).not.toContain(walkRoomId)
    expect(kavonLives).not.toContain(groupRoomId)
    expect(await errorCode(room(world, kavon.as, walkRoomId))).toBe('room_not_found')
    expect(await errorCode(joinRoom(world, kavon.as, walkRoomId, 'watching', 'invited'))).toBe(
      'room_not_found',
    )
    expect(
      (await feedPage(world, kavon.as, 'friends')).cards.filter(isLive).map((c) => c.roomId),
    ).not.toContain(walkRoomId)
    // Location: the share was revoked by the block; no new share can target the pair.
    expect(await visibleShares(kavon.as)).toEqual([])
    expect(
      (await db.rpc<Array<{ id: string }>>('location_shares_mine', {}, xavier.as)).map((s) => s.id),
    ).not.toContain(share.id)
    expect(
      await errorCode(
        db.rpc(
          'location_share_create',
          {
            audience_type: 'friend',
            audience_id: kavon.humanId,
            precision: 'precise',
            duration_seconds: 3600,
            lat: POINTS.northBeach.lat,
            lng: POINTS.northBeach.lng,
          },
          xavier.as,
        ),
      ),
    ).toBe('blocked')
    expect(
      await errorCode(
        db.rpc(
          'location_share_create',
          {
            audience_type: 'friend',
            audience_id: xavier.humanId,
            precision: 'precise',
            duration_seconds: 3600,
            lat: POINTS.northBeach.lat,
            lng: POINTS.northBeach.lng,
          },
          kavon.as,
        ),
      ),
    ).toBe('blocked')
    // Notifications: nothing new from Xavier reaches Kavon (friend request, follow, a group message).
    expect(
      await errorCode(db.rpc('friend_request_send', { target_human_id: kavon.humanId }, xavier.as)),
    ).toBe('blocked')
    expect(
      await errorCode(db.rpc('friend_request_send', { target_human_id: xavier.humanId }, kavon.as)),
    ).toBe('blocked')
    expect(
      await errorCode(
        db.rpc('follow_set', { target_human_id: kavon.humanId, following: true }, xavier.as),
      ),
    ).toBe('blocked')
    const groupPing = await sendText(world, xavier.as, weekendCrew.conversationId, 'group ping')
    expect(await fromXavier()).toEqual(notificationsBefore)
    expect(
      (await notifications(world, maya.as)).some(
        (n) => n.type === 'group_message' && n.objectId === groupPing.id,
      ),
    ).toBe(true)
    // Search and profiles: hidden both ways; being blocked is never revealed as such.
    expect((await search(world, kavon.as, 'Xavier')).people).toEqual([])
    expect((await search(world, kavon.as, 'Hello from Earth')).posts).toEqual([])
    expect((await search(world, xavier.as, 'Kavon')).people).toEqual([])
    expect((await search(world, xavier.as, 'Giraffe')).posts).toEqual([])
    expect(await errorCode(profile(world, kavon.as, 'xavier'))).toBe('not_visible')
    expect(await errorCode(profile(world, xavier.as, 'kavon'))).toBe('not_visible')
    // Feed: nothing by Xavier for Kavon in any scope, nothing by Kavon for Xavier; others unaffected.
    for (const scope of ['friends', 'world'] as const) {
      expect(await feedCandidateIds(world, kavon.as, scope)).not.toContain(friendsPostId)
      const page = await feedPage(world, kavon.as, scope)
      expect(
        page.cards.filter((c) => c.kind === 'post' && c.author.humanId === xavier.humanId),
      ).toEqual([])
      expect(await feedCardIds(world, xavier.as, scope)).not.toContain(kavonWorldPost)
    }
    expect(await errorCode(postDetail(world, kavon.as, friendsPostId))).toBe('post_not_found')
    expect(await errorCode(postDetail(world, xavier.as, kavonWorldPost))).toBe('post_not_found')
    expect(await feedCardIds(world, null, 'world')).toContain(kavonWorldPost)
    expect((await search(world, maya.as, 'Kavon')).people.map((p) => p.humanId)).toEqual([
      kavon.humanId,
    ])
    // The group survives the block: both stay members, both read and write the group chat.
    expect(await groupDetail(world, kavon.as, weekendCrew.groupId)).toMatchObject({
      myRole: 'member',
      memberCount: 3,
    })
    expect(
      (await messagesSince(world, kavon.as, weekendCrew.conversationId)).messages.map((m) => m.id),
    ).toContain(groupPing.id)
    const pong = await sendText(world, kavon.as, weekendCrew.conversationId, 'group pong')
    expect(
      (
        await messagesSince(world, xavier.as, weekendCrew.conversationId, groupPing.id)
      ).messages.map((m) => m.id),
    ).toEqual([pong.id])
    expect((await notifications(world, xavier.as)).filter((n) => n.objectId === pong.id)).toEqual(
      [],
    )
    expect(
      (await notifications(world, maya.as)).some(
        (n) => n.type === 'group_message' && n.objectId === pong.id,
      ),
    ).toBe(true)

    // Unblocking restores discovery and messaging, never the friendship.
    await db.rpc('block_set', { target_human_id: kavon.humanId, blocked: false }, xavier.as)
    expect((await search(world, kavon.as, 'Xavier')).people.map((p) => p.humanId)).toEqual([
      xavier.humanId,
    ])
    expect((await profile(world, kavon.as, 'xavier')).relationship).toMatchObject({
      isFriend: false,
      friendRequest: 'none',
    })
    expect(await feedCardIds(world, xavier.as, 'world')).toContain(kavonWorldPost)
    expect(await errorCode(postDetail(world, kavon.as, friendsPostId))).toBe('post_not_found')
    expect(await liveRoomIds(world, kavon.as, 'friends')).not.toContain(walkRoomId)
    expect(await errorCode(sendText(world, kavon.as, dm.id, 'hello again'))).toBeNull()
    // The block ejected Kavon from the group's live room as `removed` (0360: the moderator's block
    // is a removal), so that room stays closed to him for its lifetime; the next group room is his again.
    expect(await liveRoomIds(world, kavon.as, 'friends')).not.toContain(groupRoomId)
    expect(await errorCode(room(world, kavon.as, groupRoomId))).toBe('room_not_found')
    await db.rpc('room_end', { room_id: walkRoomId }, xavier.as)
    await db.rpc('room_end', { room_id: groupRoomId }, xavier.as)
    const next = await db.rpc<{ room: { id: string }; created: boolean }>(
      'room_start',
      { context_type: 'group', context_id: weekendCrew.groupId },
      kavon.as,
    )
    expect(next.created).toBe(true)
    expect(
      (await room(world, xavier.as, next.room.id)).participants.map((p) => [
        p.humanId,
        p.relationToViewer,
      ]),
    ).toEqual([[kavon.humanId, 'shared_group']])
    expect(await liveRoomIds(world, kavon.as, 'friends')).toContain(next.room.id)
    expect((await liveNotificationsFor(world, xavier.as, next.room.id)).map((n) => n.type)).toEqual(
      ['group_live'],
    )
    await db.rpc('room_end', { room_id: next.room.id }, kavon.as)
  })

  it('notification creation/dedupe: a friend Live notifies once, churn never, a direct friend joining on camera once more, then nothing', async () => {
    const { db } = world
    const hana = await existingHuman(world, 'Hana')
    const rio = await existingHuman(world, 'Rio')
    const yara = await existingHuman(world, 'Yara')
    const wes = await existingHuman(world, 'Wes')
    const zed = await existingHuman(world, 'Zed')
    const vic = await existingHuman(world, 'Vic')
    for (const friend of [rio, yara, wes, zed, vic]) await makeFriends(world, hana, friend)
    for (const friend of [yara, zed, vic]) await makeFriends(world, rio, friend)
    const unreadBefore = await unreadCount(world, rio.as)

    // Initial: exactly one friend_live for Rio with the spec copy; nothing for the host.
    const started = await db.rpc<{ room: { id: string } }>(
      'room_start',
      { context_type: 'standalone', context_id: null, title: 'Cooking dinner' },
      hana.as,
    )
    const roomId = started.room.id
    let mine = await liveNotificationsFor(world, rio.as, roomId)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({
      type: 'friend_live',
      actorHumanId: hana.humanId,
      actorHandle: hana.handle,
      priority: 'critical_social',
      objectType: 'room',
      objectId: roomId,
      readAt: null,
    })
    expect(NOTIFICATION_PAYLOAD_SCHEMAS.friend_live.parse(mine[0]?.payload)).toEqual({
      name: 'Hana',
      activity: 'Cooking dinner',
    })
    expect({ title: mine[0]?.title, body: mine[0]?.body }).toEqual(
      expectedCopy(mine[0] as NotificationDto),
    )
    expect(mine[0]?.title).toBe('Hana is live')
    expect(await unreadCount(world, rio.as)).toBe(unreadBefore + 1)
    expect(await liveNotificationsFor(world, hana.as, roomId)).toEqual([])
    // Wes (a friend of Hana, not of Rio) got his own initial one; Ben, a stranger, nothing.
    expect((await liveNotificationsFor(world, wes.as, roomId)).map((n) => n.type)).toEqual([
      'friend_live',
    ])
    expect(await liveNotificationsFor(world, ben.as, roomId)).toEqual([])

    // Churn: a viewer joining, a non-friend of Rio on camera, the host toggling media → nothing more.
    await joinRoom(world, vic.as, roomId, 'watching', 'invited')
    await joinRoom(world, wes.as, roomId, 'camera', 'friends')
    await db.rpc('room_set_media_state', { room_id: roomId, media_state: 'audio' }, hana.as)
    await db.rpc('room_set_media_state', { room_id: roomId, media_state: 'camera' }, hana.as)
    expect(await liveNotificationsFor(world, rio.as, roomId)).toHaveLength(1)

    // A direct friend of Rio joining on camera: one more, naming Rio's friends first.
    await joinRoom(world, yara.as, roomId, 'camera', 'friends')
    mine = await liveNotificationsFor(world, rio.as, roomId)
    expect(mine).toHaveLength(2)
    expect(mine[1]).toMatchObject({ type: 'multi_live', actorHumanId: yara.humanId })
    expect(NOTIFICATION_PAYLOAD_SCHEMAS.multi_live.parse(mine[1]?.payload)).toEqual({
      names: ['Hana', 'Yara', 'Wes'],
      total: 3,
    })
    expect({ title: mine[1]?.title, body: mine[1]?.body }).toEqual(
      expectedCopy(mine[1] as NotificationDto),
    )
    expect(await unreadCount(world, rio.as)).toBe(unreadBefore + 2)

    // The extra send is used up: another direct friend on camera, the viewer going audio → nothing.
    await joinRoom(world, zed.as, roomId, 'camera', 'friends')
    await db.rpc(
      'room_set_media_state',
      { room_id: roomId, media_state: 'audio', consent_level: 'friends' },
      vic.as,
    )
    expect(await liveNotificationsFor(world, rio.as, roomId)).toHaveLength(2)
    // Participants are never notified about their own room; Rio can read and settle the list.
    for (const inside of [hana, yara, wes, zed, vic]) {
      expect(
        (await liveNotificationsFor(world, inside.as, roomId)).filter(
          (n) => n.createdAt > (mine[0]?.createdAt ?? ''),
        ),
      ).toEqual([])
    }
    const marked = await db.rpc<{ id: string; readAt: string | null }>(
      'notification_mark_read',
      { id: mine[0]?.id },
      rio.as,
    )
    expect(marked.readAt).not.toBeNull()
    expect(await unreadCount(world, rio.as)).toBe(unreadBefore + 1)
    expect(await errorCode(db.rpc('notification_mark_read', { id: mine[0]?.id }, ben.as))).toBe(
      'not_visible',
    )
    expect(await errorCode(db.rpc('notifications_list', {}, visitor))).toBe('not_authenticated')
    await db.rpc('room_end', { room_id: roomId }, hana.as)
  })
})
