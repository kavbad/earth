/**
 * The product gaps closed by 0996 (DB_API §1–§6; spec §17, §20, §29, §39, §40, §57–§59, §80, §86,
 * §128), end to end through the RPCs as specific callers, every result parsed with the very
 * `@earth/domain` schema the typed client uses:
 *
 *   1. `posts_by_author` — an author's root posts the caller may see, newest first, keyset paging;
 *      visitors get the world posts of public profiles only; hides, deletes, blocks and profile
 *      visibility apply.
 *   2. `identity_update(..., handle)` — the claim rules (`handle_invalid` / `handle_taken`,
 *      case-insensitive), the old handle freed, audited.
 *   3. `NotificationDto.actorHandle` — the actor's current handle, live (follows a rename, gone
 *      once the actor is deleted), for every human-targeted type.
 *   4. `ConversationSummaryDto.myPrefs` — the caller's own prefs on `conversation_get` and the list.
 *   5. `RoomDto.canJoinAudio / canJoinCamera / joinReason` — exactly what `room_join` decides.
 *   6. `location_shares_mine` — own live shares only.
 *   7. `human_delete_request` — a deleted Human is invisible everywhere; the credential claims
 *      again as a *new* pending Human (spec §80), never while an active Human exists.
 */
import {
  ConversationDetailDtoSchema,
  ConversationSummaryDtoSchema,
  LocationShareDtoSchema,
  MeDtoSchema,
  NotificationDtoSchema,
  NotificationsPageDtoSchema,
  PostViewDtoSchema,
  ProfileDtoSchema,
  PublicIdentityDtoSchema,
  RoomDtoSchema,
  type NotificationDto,
  type RoomDto,
} from '@earth/domain'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  addMember,
  befriend,
  count,
  createGroup,
  createGuest,
  createHuman,
  createUnclaimed,
  scalar,
  setFlag,
  type GroupFixture,
  type Human,
} from '../admission/fixtures'
import { BASE_AREA_SLUGS, areaBySlug, createShare } from '../geo/fixtures'
import { createPost } from '../posts/fixtures'
import {
  createGuestSession,
  createRoomInvite,
  getRoom,
  joinRoom,
  roomRow,
  rpcAt,
  secondsFromNow,
  startGroupRoom,
  startStandaloneRoom,
} from '../rooms/fixtures'

const PostsPageSchema = z.object({
  posts: z.array(PostViewDtoSchema),
  nextCursor: z.string().nullable(),
})
type PostsPage = z.infer<typeof PostsPageSchema>

const HumanDeleteResultSchema = z.object({
  humanId: z.uuid(),
  authUserId: z.uuid(),
  deletedAt: z.iso.datetime({ offset: true }),
})

async function postsByAuthor(
  db: TestDb,
  handle: string,
  as: RoleSpec,
  options: { cursor?: string | null; limit?: number | null } = {},
): Promise<PostsPage> {
  return PostsPageSchema.parse(
    await db.rpc(
      'posts_by_author',
      { handle, cursor: options.cursor ?? null, limit: options.limit ?? null },
      as,
    ),
  )
}

async function postIds(
  db: TestDb,
  handle: string,
  as: RoleSpec,
  options: { cursor?: string | null; limit?: number | null } = {},
): Promise<string[]> {
  return (await postsByAuthor(db, handle, as, options)).posts.map((view) => view.post.id)
}

async function notificationsOf(db: TestDb, as: RoleSpec): Promise<NotificationDto[]> {
  return NotificationsPageDtoSchema.parse(
    await db.rpc('notifications_list', { cursor: null, limit: 50 }, as),
  ).notifications
}

async function errorCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

describe('product gaps (0996) — verification', () => {
  let db: TestDb
  let alice: Human
  let bob: Human
  let carol: Human
  let dana: Human
  let crew: GroupFixture

  beforeAll(async () => {
    db = await createTestDb()
    alice = await createHuman(db, { handle: 'alice', displayName: 'Alice' })
    bob = await createHuman(db, { handle: 'bob', displayName: 'Bob' })
    carol = await createHuman(db, { handle: 'carol', displayName: 'Carol', visibility: 'limited' })
    dana = await createHuman(db, { handle: 'dana', displayName: 'Dana', visibility: 'hidden' })
    await befriend(db, alice, bob)
    crew = await createGroup(db, alice, 'Gap Crew')
    await addMember(db, crew, bob)
  })

  afterAll(async () => {
    await db.drop()
  })

  // -------------------------------------------------------------------------------------------------
  describe('1. posts_by_author', () => {
    let w1: string
    let f1: string
    let w2: string
    let reply: string

    beforeAll(async () => {
      w1 = (await createPost(db, alice, { text: 'world one', audience: 'world' })).post.id
      f1 = (await createPost(db, alice, { text: 'friends only', audience: 'friends' })).post.id
      w2 = (await createPost(db, alice, { text: 'world two', audience: 'world' })).post.id
      reply = (
        await createPost(db, alice, { text: 'my own reply', audience: 'world', parentPostId: w1 })
      ).post.id
    })

    it('lists root posts newest first as the caller may see them, never replies', async () => {
      expect(await postIds(db, 'alice', 'visitor')).toEqual([w2, w1])
      expect(await postIds(db, 'alice', bob.as)).toEqual([w2, f1, w1])
      expect(await postIds(db, 'alice', carol.as)).toEqual([w2, w1])
      expect(await postIds(db, 'alice', alice.as)).toEqual([w2, f1, w1])
      const page = await postsByAuthor(db, ' @Alice ', bob.as)
      expect(page.posts.map((view) => view.post.id)).not.toContain(reply)
      expect(page.posts[0]?.author.handle).toBe('alice')
      expect(page.posts.every((view) => view.post.parentPostId === null)).toBe(true)
    })

    it('pages by (created_at, id) with an opaque cursor that must belong to the author', async () => {
      const first = await postsByAuthor(db, 'alice', bob.as, { limit: 2 })
      expect(first.posts.map((view) => view.post.id)).toEqual([w2, f1])
      expect(first.nextCursor).not.toBeNull()
      const second = await postsByAuthor(db, 'alice', bob.as, {
        cursor: first.nextCursor,
        limit: 2,
      })
      expect(second.posts.map((view) => view.post.id)).toEqual([w1])
      expect(second.nextCursor).toBeNull()
      // Visitors page over their own (narrower) view with the same cursor mechanics.
      const visitorFirst = await postsByAuthor(db, 'alice', 'visitor', { limit: 1 })
      expect(visitorFirst.posts.map((view) => view.post.id)).toEqual([w2])
      expect(
        (
          await postsByAuthor(db, 'alice', 'visitor', { cursor: visitorFirst.nextCursor })
        ).posts.map((v) => v.post.id),
      ).toEqual([w1])
      await db.expectError(
        postsByAuthor(db, 'alice', bob.as, { cursor: 'garbage' }),
        'invalid_input',
      )
      await db.expectError(
        postsByAuthor(db, 'alice', bob.as, { cursor: `2026-01-01T00:00:00+00:00,${randomUUID()}` }),
        'invalid_input',
      )
      // A cursor from another author's post is refused.
      const bobPost = await createPost(db, bob, { text: 'bob world', audience: 'world' })
      const bobPage = await postsByAuthor(db, 'bob', alice.as, { limit: 1 })
      expect(bobPage.posts.map((view) => view.post.id)).toEqual([bobPost.post.id])
      const bobCursor = `${bobPost.post.createdAt},${bobPost.post.id}`
      await db.expectError(
        postsByAuthor(db, 'alice', bob.as, { cursor: bobCursor }),
        'invalid_input',
      )
      // limit is clamped: 0 and 1000 do not fail.
      expect((await postsByAuthor(db, 'alice', bob.as, { limit: 0 })).posts).toHaveLength(1)
      expect((await postsByAuthor(db, 'alice', bob.as, { limit: 1000 })).posts).toHaveLength(3)
    })

    it('respects profile visibility, blocks and unknown handles with not_visible (never a different code)', async () => {
      await db.expectError(postsByAuthor(db, 'carol', 'visitor'), 'not_visible')
      expect(await postIds(db, 'carol', bob.as)).toEqual([])
      await db.expectError(postsByAuthor(db, 'dana', 'visitor'), 'not_visible')
      await db.expectError(postsByAuthor(db, 'dana', bob.as), 'not_visible')
      expect(await postIds(db, 'dana', dana.as)).toEqual([])
      await db.expectError(postsByAuthor(db, 'nobody', bob.as), 'not_visible')
      await db.expectError(postsByAuthor(db, 'nobody', 'visitor'), 'not_visible')
      await db.rpc('block_set', { target_human_id: bob.humanId, blocked: true }, carol.as)
      await db.expectError(postsByAuthor(db, 'carol', bob.as), 'not_visible')
      await db.expectError(postsByAuthor(db, 'bob', carol.as), 'not_visible')
      await db.rpc('block_set', { target_human_id: bob.humanId, blocked: false }, carol.as)
      expect(await postIds(db, 'carol', bob.as)).toEqual([])
    })

    it('drops hidden and deleted posts; visitors need PUBLIC_WORLD_ENABLED', async () => {
      await db.rpc('post_hide', { post_id: w1 }, bob.as)
      expect(await postIds(db, 'alice', bob.as)).toEqual([w2, f1])
      expect(await postIds(db, 'alice', carol.as)).toEqual([w2, w1])
      await db.rpc('post_delete', { post_id: w2 }, alice.as)
      expect(await postIds(db, 'alice', 'visitor')).toEqual([w1])
      expect(await postIds(db, 'alice', alice.as)).toEqual([f1, w1])
      await setFlag(db, 'PUBLIC_WORLD_ENABLED', false)
      expect(await postIds(db, 'alice', 'visitor')).toEqual([])
      expect(await postIds(db, 'alice', carol.as)).toEqual([w1])
      await setFlag(db, 'PUBLIC_WORLD_ENABLED', true)
    })
  })

  // -------------------------------------------------------------------------------------------------
  describe('2. identity_update with a handle', () => {
    it('changes the handle with the claim rules and frees the old one', async () => {
      const updated = PublicIdentityDtoSchema.parse(
        await db.rpc('identity_update', { handle: ' @Alice_New ' }, alice.as),
      )
      expect(updated).toMatchObject({
        humanId: alice.humanId,
        handle: 'alice_new',
        displayName: 'Alice',
      })
      expect(
        ProfileDtoSchema.parse(await db.rpc('profile_get', { handle: 'ALICE_NEW' }, bob.as))
          .identity.handle,
      ).toBe('alice_new')
      await db.expectError(db.rpc('profile_get', { handle: 'alice' }, bob.as), 'not_visible')
      expect(await db.rpc('handle_available', { handle: 'alice' }, bob.as)).toBe(true)
      expect(
        await count(
          db,
          'private.audit_log',
          "action = 'identity_handle_change' and target_id = $1",
          [alice.humanId],
        ),
      ).toBe(1)
      alice = { ...alice, handle: 'alice_new' }
    })

    it('refuses invalid and taken handles (case-insensitively) and leaves everything unchanged', async () => {
      await db.expectError(db.rpc('identity_update', { handle: 'ab' }, alice.as), 'handle_invalid')
      await db.expectError(
        db.rpc('identity_update', { handle: 'no spaces' }, alice.as),
        'handle_invalid',
      )
      await db.expectError(db.rpc('identity_update', { handle: '' }, alice.as), 'handle_invalid')
      await db.expectError(db.rpc('identity_update', { handle: 'bob' }, alice.as), 'handle_taken')
      await db.expectError(
        db.rpc('identity_update', { handle: 'BOB', display_name: 'Not applied' }, alice.as),
        'handle_taken',
      )
      expect(
        await scalar<string>(db, 'display_name from public.public_identities where human_id = $1', [
          alice.humanId,
        ]),
      ).toBe('Alice')
      expect(
        await scalar<string>(db, 'handle from public.public_identities where human_id = $1', [
          alice.humanId,
        ]),
      ).toBe('alice_new')
      // The caller's own handle (any case) is a no-op; null leaves it alone.
      expect(
        PublicIdentityDtoSchema.parse(
          await db.rpc('identity_update', { handle: 'ALICE_NEW' }, alice.as),
        ).handle,
      ).toBe('alice_new')
      expect(
        PublicIdentityDtoSchema.parse(
          await db.rpc('identity_update', { bio: 'still me', handle: null }, alice.as),
        ),
      ).toMatchObject({ handle: 'alice_new', bio: 'still me' })
      expect(
        await count(
          db,
          'private.audit_log',
          "action = 'identity_handle_change' and target_id = $1",
          [alice.humanId],
        ),
      ).toBe(1)
    })

    it('a race on the same handle ends in handle_taken, not a raw unique violation', async () => {
      // Bob takes a handle; Carol's check passed before Bob's commit in a real race — the unique
      // index on lower(handle) is the last line, mapped to the machine code.
      await db.rpc('identity_update', { handle: 'shared_one' }, bob.as)
      expect(await errorCode(db.rpc('identity_update', { handle: 'Shared_One' }, carol.as))).toBe(
        'handle_taken',
      )
      await db.rpc('identity_update', { handle: 'bob' }, bob.as)
    })
  })

  // -------------------------------------------------------------------------------------------------
  describe('3. NotificationDto.actorHandle', () => {
    it('carries the actor’s current handle for friend_request, friend_accepted and follow', async () => {
      await db.rpc('friend_request_send', { target_human_id: alice.humanId }, carol.as)
      const request = (await notificationsOf(db, alice.as)).find((n) => n.type === 'friend_request')
      expect(request).toMatchObject({ actorHumanId: carol.humanId, actorHandle: 'carol' })
      // A rename is visible on the existing row: nothing stale is stored.
      await db.rpc('identity_update', { handle: 'carol_renamed' }, carol.as)
      expect(
        (await notificationsOf(db, alice.as)).find((n) => n.type === 'friend_request')?.actorHandle,
      ).toBe('carol_renamed')
      const marked = NotificationDtoSchema.parse(
        await db.rpc('notification_mark_read', { id: request?.id }, alice.as),
      )
      expect(marked.actorHandle).toBe('carol_renamed')
      await db.rpc('friend_request_accept', { source_human_id: carol.humanId }, alice.as)
      const accepted = (await notificationsOf(db, carol.as)).find(
        (n) => n.type === 'friend_accepted',
      )
      expect(accepted).toMatchObject({ actorHumanId: alice.humanId, actorHandle: 'alice_new' })
      await db.rpc('follow_set', { target_human_id: alice.humanId, following: true }, bob.as)
      const follow = (await notificationsOf(db, alice.as)).find((n) => n.type === 'follow')
      expect(follow).toMatchObject({ actorHumanId: bob.humanId, actorHandle: 'bob' })
      await db.rpc('identity_update', { handle: 'carol' }, carol.as)
      await db.rpc('friend_remove', { other_human_id: carol.humanId }, alice.as)
      await db.rpc('follow_set', { target_human_id: alice.humanId, following: false }, bob.as)
    })

    it('is null without an actor, and the payload is untouched', async () => {
      await db.sql.query(
        `select earth.notify($1, 'group_invitation', null, 'group', $2, '{"name": "Xavier", "groupName": "Crew"}'::jsonb)`,
        [alice.humanId, crew.groupId],
      )
      const invitation = (await notificationsOf(db, alice.as)).find(
        (n) => n.type === 'group_invitation',
      )
      expect(invitation).toMatchObject({
        actorHumanId: null,
        actorHandle: null,
        payload: { name: 'Xavier', groupName: 'Crew' },
      })
      const { rows } = await db.sql.query<{ payload: unknown }>(
        `select payload from public.notifications where recipient_human_id = $1 and type = 'follow'`,
        [alice.humanId],
      )
      expect(rows[0]?.payload).toEqual({ name: 'Bob' })
      await db.sql.query('delete from public.notifications where recipient_human_id = $1', [
        alice.humanId,
      ])
    })
  })

  // -------------------------------------------------------------------------------------------------
  describe('4. ConversationSummaryDto.myPrefs', () => {
    let dm: string
    let messageId: string

    beforeAll(async () => {
      dm = (
        await db.rpc<{ id: string }>(
          'conversation_direct_get_or_create',
          { other_human_id: bob.humanId },
          alice.as,
        )
      ).id
      messageId = (
        await db.rpc<{ id: string }>(
          'message_send',
          {
            conversation_id: dm,
            client_id: randomUUID(),
            type: 'text',
            text: 'prefs?',
            payload: {},
            reply_to_message_id: null,
          },
          bob.as,
        )
      ).id
    })

    it('conversation_get carries the caller’s own prefs and read state', async () => {
      const fresh = ConversationDetailDtoSchema.parse(
        await db.rpc('conversation_get', { conversation_id: dm }, alice.as),
      )
      expect(fresh.myPrefs).toEqual({
        muteState: 'none',
        notificationLevel: 'all',
        lastReadMessageId: null,
      })
      await db.rpc(
        'conversation_set_prefs',
        { conversation_id: dm, mute_state: 'muted', notification_level: 'mentions' },
        alice.as,
      )
      await db.rpc(
        'conversation_mark_read',
        { conversation_id: dm, message_id: messageId },
        alice.as,
      )
      const after = ConversationDetailDtoSchema.parse(
        await db.rpc('conversation_get', { conversation_id: dm }, alice.as),
      )
      expect(after.myPrefs).toEqual({
        muteState: 'muted',
        notificationLevel: 'mentions',
        lastReadMessageId: messageId,
      })
      // Bob's own prefs, not Alice's.
      const bobs = ConversationDetailDtoSchema.parse(
        await db.rpc('conversation_get', { conversation_id: dm }, bob.as),
      )
      expect(bobs.myPrefs).toEqual({
        muteState: 'none',
        notificationLevel: 'all',
        lastReadMessageId: null,
      })
    })

    it('the list carries them too (the same summary)', async () => {
      const list = z
        .object({ conversations: z.array(ConversationSummaryDtoSchema) })
        .parse(await db.rpc('conversations_list', { cursor: null, limit: 30 }, alice.as))
      const row = list.conversations.find((c) => c.id === dm)
      expect(row?.myPrefs).toEqual({
        muteState: 'muted',
        notificationLevel: 'mentions',
        lastReadMessageId: messageId,
      })
    })
  })

  // -------------------------------------------------------------------------------------------------
  describe('5. RoomDto join affordances', () => {
    let roomId: string

    function flags(room: RoomDto): {
      audio: boolean | undefined
      camera: boolean | undefined
      reason: string | null | undefined
    } {
      return { audio: room.canJoinAudio, camera: room.canJoinCamera, reason: room.joinReason }
    }

    beforeAll(async () => {
      const started = await startStandaloneRoom(db, alice, 'Gap room')
      roomId = started.room.id
      await db.rpc('room_consent', { room_id: roomId, level: 'world' }, alice.as)
      const opened = await db.rpc<{ applied: boolean }>(
        'room_set_visibility',
        { room_id: roomId, visibility: 'world', join_policy: 'anyone_with_link' },
        alice.as,
      )
      expect(opened.applied).toBe(true)
    })

    it('says what room_join would do: the policy refuses a stranger, admits the initiator, tells visitors to sign in', async () => {
      expect(flags(await getRoom(db, roomId, alice.as))).toEqual({
        audio: true,
        camera: true,
        reason: null,
      })
      const stranger = await getRoom(db, roomId, carol.as)
      expect(flags(stranger)).toEqual({ audio: false, camera: false, reason: 'join_not_allowed' })
      expect(await errorCode(joinRoom(db, roomId, carol, 'audio', 'world'))).toBe(
        stranger.joinReason,
      )
      expect(await errorCode(joinRoom(db, roomId, carol, 'camera', 'world'))).toBe(
        stranger.joinReason,
      )
      // Watching only takes visibility: the viewer seat is fine, the affordance is about publishing.
      expect((await joinRoom(db, roomId, carol, 'watching')).myParticipant?.status).toBe('active')
      expect(flags(await getRoom(db, roomId, carol.as))).toEqual({
        audio: false,
        camera: false,
        reason: 'join_not_allowed',
      })
      const visitor = RoomDtoSchema.parse(await db.rpc('room_get', { room_id: roomId }, 'visitor'))
      expect(flags(visitor)).toEqual({ audio: false, camera: false, reason: 'not_authenticated' })
      expect(
        await errorCode(
          db.rpc(
            'room_join',
            { room_id: roomId, media_state: 'audio', consent_level: 'world' },
            'visitor',
          ),
        ),
      ).toBe('not_authenticated')
    })

    it('follows the join policy: request seats wait, anyone publishes, links admit', async () => {
      await db.rpc('room_set_join_policy', { room_id: roomId, join_policy: 'request' }, alice.as)
      expect(flags(await getRoom(db, roomId, carol.as))).toEqual({
        audio: true,
        camera: true,
        reason: null,
      })
      const waiting = await joinRoom(db, roomId, carol, 'camera', 'world')
      expect(waiting.myParticipant?.status).toBe('waiting')
      await db.rpc('room_leave', { room_id: roomId }, carol.as)
      await db.rpc(
        'room_set_join_policy',
        { room_id: roomId, join_policy: 'anyone_with_link' },
        alice.as,
      )
      // Carol's waiting seat was never admitted: the policy applies again.
      expect(flags(await getRoom(db, roomId, carol.as))).toEqual({
        audio: false,
        camera: false,
        reason: 'join_not_allowed',
      })
      const invite = await createRoomInvite(db, roomId, alice)
      const linked = RoomDtoSchema.parse(
        await db.rpc(
          'room_invite_join',
          { token: invite.token, media_state: 'audio', consent_level: 'world' },
          carol.as,
        ),
      )
      expect(linked.myParticipant).toMatchObject({ status: 'active', mediaState: 'audio' })
      // An admitted seat keeps its invitation (reconnects never re-pass the policy).
      expect(flags(await getRoom(db, roomId, carol.as))).toEqual({
        audio: true,
        camera: true,
        reason: null,
      })
      await db.rpc('room_leave', { room_id: roomId }, carol.as)
      expect(flags(await getRoom(db, roomId, carol.as))).toEqual({
        audio: true,
        camera: true,
        reason: null,
      })
    })

    it('a Guest may re-enter their room unless GUEST_ROOMS_ENABLED is off or guests are disabled', async () => {
      const guest = await createGuest(db)
      const invite = await createRoomInvite(db, roomId, alice)
      await createGuestSession(db, guest, invite.token, 'Sam')
      expect(flags(await getRoom(db, roomId, guest.as))).toEqual({
        audio: true,
        camera: true,
        reason: null,
      })
      await setFlag(db, 'GUEST_ROOMS_ENABLED', false)
      expect(flags(await getRoom(db, roomId, guest.as))).toEqual({
        audio: false,
        camera: false,
        reason: 'feature_disabled',
      })
      expect(
        await errorCode(
          db.rpc(
            'room_join',
            { room_id: roomId, media_state: 'audio', consent_level: 'world' },
            guest.as,
          ),
        ),
      ).toBe('feature_disabled')
      await setFlag(db, 'GUEST_ROOMS_ENABLED', true)
    })

    it('an ended room is room_ended for everyone who still sees it; a hidden room stays room_not_found', async () => {
      const group = await startGroupRoom(db, alice, crew)
      // Group rooms are invisible to non-members: no DTO, exactly like room_join.
      await db.expectError(
        db.rpc('room_get', { room_id: group.room.id }, carol.as),
        'room_not_found',
      )
      expect(await errorCode(joinRoom(db, group.room.id, carol, 'audio', 'group'))).toBe(
        'room_not_found',
      )
      expect(flags(await getRoom(db, group.room.id, bob.as))).toEqual({
        audio: true,
        camera: true,
        reason: null,
      })
      await db.rpc('room_end', { room_id: group.room.id, reason: null }, alice.as)
      expect(flags(await getRoom(db, group.room.id, bob.as))).toEqual({
        audio: false,
        camera: false,
        reason: 'room_ended',
      })
      expect(await errorCode(joinRoom(db, group.room.id, bob, 'audio', 'group'))).toBe('room_ended')
      await db.rpc('room_end', { room_id: roomId, reason: null }, alice.as)
      expect(flags(await getRoom(db, roomId, alice.as))).toEqual({
        audio: false,
        camera: false,
        reason: 'room_ended',
      })
    })
  })

  // -------------------------------------------------------------------------------------------------
  describe('6. location_shares_mine', () => {
    it('answers the caller’s live shares only, never anyone else’s, and drops revoked or expired ones', async () => {
      const toBob = await createShare(db, alice, {
        audienceId: bob.humanId,
        precision: 'precise',
        durationSeconds: 3600,
      })
      const toCrew = await createShare(db, alice, {
        audienceType: 'group',
        audienceId: crew.groupId,
        precision: 'city',
        durationSeconds: 7200,
      })
      const mine = z
        .array(LocationShareDtoSchema)
        .parse(await db.rpc('location_shares_mine', {}, alice.as))
      expect(mine.map((share) => share.id)).toEqual([toCrew.id, toBob.id])
      expect(
        mine.every((share) => share.humanId === alice.humanId && share.revokedAt === null),
      ).toBe(true)
      expect(await db.rpc('location_shares_mine', {}, bob.as)).toEqual([])
      await db.rpc('location_share_revoke', { share_id: toBob.id }, alice.as)
      expect(
        (await db.rpc<Array<{ id: string }>>('location_shares_mine', {}, alice.as)).map(
          (s) => s.id,
        ),
      ).toEqual([toCrew.id])
      expect(await rpcAt(db, 'location_shares_mine', {}, alice.as, secondsFromNow(7300))).toEqual(
        [],
      )
      await db.expectError(db.rpc('location_shares_mine', {}, 'visitor'), 'not_authenticated')
      await db.expectError(
        db.rpc('location_shares_mine', {}, (await createGuest(db)).as),
        'not_a_human',
      )
      await db.rpc('location_share_revoke', { share_id: toCrew.id }, alice.as)
    })
  })

  // -------------------------------------------------------------------------------------------------
  describe('7. human_delete_request', () => {
    let victim: Human
    let ownGroup: GroupFixture
    let dm: string
    let postId: string
    let sharedRoom: string
    let soloRoom: string
    let shareId: string
    let deletion: z.infer<typeof HumanDeleteResultSchema>

    beforeAll(async () => {
      victim = await createHuman(db, { handle: 'victim1', displayName: 'Victor' })
      await befriend(db, alice, victim)
      await db.rpc('follow_set', { target_human_id: victim.humanId, following: true }, bob.as)
      await db.rpc('friend_request_send', { target_human_id: alice.humanId }, victim.as)
      await addMember(db, crew, victim)
      ownGroup = await createGroup(db, victim, 'Victor Crew')
      await addMember(db, ownGroup, bob)
      dm = (
        await db.rpc<{ id: string }>(
          'conversation_direct_get_or_create',
          { other_human_id: alice.humanId },
          victim.as,
        )
      ).id
      await db.rpc(
        'message_send',
        {
          conversation_id: dm,
          client_id: randomUUID(),
          type: 'text',
          text: 'before',
          payload: {},
          reply_to_message_id: null,
        },
        victim.as,
      )
      postId = (await createPost(db, victim, { text: 'victor world', audience: 'world' })).post.id
      shareId = (await createShare(db, victim, { audienceId: alice.humanId })).id
      await db.rpc(
        'push_token_register',
        { token: 'ExponentPushToken[victor]', platform: 'ios' },
        victim.as,
      )
      await db.rpc(
        'presence_ping',
        { conversation_id: dm, room_id: null, platform: 'ios' },
        victim.as,
      )
      await db.rpc(
        'context_set',
        {
          current_area_id: null,
          current_city_id: await areaBySlug(db, BASE_AREA_SLUGS.sanFrancisco),
          home_city_id: null,
        },
        victim.as,
      )
      await db.rpc('block_set', { target_human_id: dana.humanId, blocked: true }, victim.as)
      await db.rpc('block_set', { target_human_id: victim.humanId, blocked: true }, carol.as)
      sharedRoom = (await startStandaloneRoom(db, victim, 'Shared')).room.id
      await joinRoom(db, sharedRoom, alice, 'audio', 'friends')
      // A second room of Victor's own group: nobody else takes a seat.
      soloRoom = (await startGroupRoom(db, victim, ownGroup)).room.id
      expect(
        (
          await db.rpc<{ people: Array<{ handle: string }> }>(
            'search',
            { q: 'victor', limit: 10 },
            alice.as,
          )
        ).people.map((p) => p.handle),
      ).toEqual(['victim1'])
    })

    it('deletes the Human in one transaction and answers the credential to delete', async () => {
      deletion = HumanDeleteResultSchema.parse(await db.rpc('human_delete_request', {}, victim.as))
      expect(deletion).toMatchObject({ humanId: victim.humanId, authUserId: victim.userId })
      const human = (
        await db.sql.query<{
          status: string
          deleted_at: string | null
          auth_user_id: string | null
        }>('select status::text, deleted_at, auth_user_id from public.humans where id = $1', [
          victim.humanId,
        ])
      ).rows[0]
      expect(human).toMatchObject({ status: 'deleted', auth_user_id: null })
      expect(human?.deleted_at).not.toBeNull()
      expect(
        await count(db, 'public.auth_identities', 'human_id = $1 and revoked_at is null', [
          victim.humanId,
        ]),
      ).toBe(0)
      expect(
        await count(
          db,
          'private.audit_log',
          "action = 'human_delete_request' and target_id = $1 and actor_human_id = $1",
          [victim.humanId],
        ),
      ).toBe(1)
    })

    it('is invisible everywhere: profile, search, posts, groups, chats, graph, blocks, shares, devices, rooms', async () => {
      await db.expectError(db.rpc('profile_get', { handle: 'victim1' }, alice.as), 'not_visible')
      expect(
        (await db.rpc<{ people: unknown[] }>('search', { q: 'victor', limit: 10 }, alice.as))
          .people,
      ).toEqual([])
      await db.expectError(postsByAuthor(db, 'victim1', alice.as), 'not_visible')
      await db.expectError(db.rpc('post_get', { post_id: postId }, alice.as), 'post_not_found')
      await db.expectError(db.rpc('post_get', { post_id: postId }, 'visitor'), 'post_not_found')
      const crewDetail = await db.rpc<{ members: Array<{ humanId: string }> }>(
        'group_get',
        { group_id: crew.groupId },
        alice.as,
      )
      expect(crewDetail.members.map((m) => m.humanId)).not.toContain(victim.humanId)
      // Victor's own group was handed to Bob and stays alive.
      const own = await db.rpc<{
        myRole: string
        members: Array<{ humanId: string; role: string }>
      }>('group_get', { group_id: ownGroup.groupId }, bob.as)
      expect(own.myRole).toBe('owner')
      expect(own.members.map((m) => m.humanId)).toEqual([bob.humanId])
      const chat = ConversationDetailDtoSchema.parse(
        await db.rpc('conversation_get', { conversation_id: dm }, alice.as),
      )
      expect(chat.members.map((m) => m.humanId)).toEqual([alice.humanId])
      expect(
        await count(db, 'public.conversation_members', 'human_id = $1', [victim.humanId]),
      ).toBe(0)
      expect(
        await count(db, 'public.group_members', "human_id = $1 and status = 'active'", [
          victim.humanId,
        ]),
      ).toBe(0)
      expect(
        await count(db, 'public.relationships', 'source_human_id = $1 or target_human_id = $1', [
          victim.humanId,
        ]),
      ).toBe(0)
      expect(
        await count(db, 'public.blocks', 'blocker_human_id = $1 or blocked_human_id = $1', [
          victim.humanId,
        ]),
      ).toBe(0)
      expect(
        await scalar<string | null>(db, 'revoked_at from public.location_shares where id = $1', [
          shareId,
        ]),
      ).not.toBeNull()
      expect(await count(db, 'public.push_tokens', 'human_id = $1', [victim.humanId])).toBe(0)
      expect(await count(db, 'public.human_presence', 'human_id = $1', [victim.humanId])).toBe(0)
      expect(await count(db, 'public.human_context', 'human_id = $1', [victim.humanId])).toBe(0)
      expect(
        await count(db, 'public.notifications', 'recipient_human_id = $1', [victim.humanId]),
      ).toBe(0)
      // Alice keeps the room: she is its moderator now; the room nobody else sat in ended.
      const shared = await roomRow(db, sharedRoom)
      expect(shared.status).toBe('active')
      expect((await getRoom(db, sharedRoom, alice.as)).myParticipant?.role).toBe('moderator')
      expect(
        await count(
          db,
          'public.room_participants',
          "human_id = $1 and status in ('invited', 'waiting', 'active')",
          [victim.humanId],
        ),
      ).toBe(0)
      expect(await roomRow(db, soloRoom)).toMatchObject({
        status: 'ended',
        ended_reason: 'human_deleted',
      })
      // The identity is anonymized and the handle freed by suffixing.
      const identity = (
        await db.sql.query<{
          display_name: string
          handle: string
          profile_visibility: string
          bio: string | null
        }>(
          'select display_name, handle, profile_visibility::text, bio from public.public_identities where human_id = $1',
          [victim.humanId],
        )
      ).rows[0]
      expect(identity).toMatchObject({
        display_name: 'Deleted',
        profile_visibility: 'hidden',
        bio: null,
      })
      expect(identity?.handle).toMatch(/^victim1_[0-9a-f]{7}$/)
      await db.expectError(
        db.rpc('profile_get', { handle: identity?.handle }, alice.as),
        'not_visible',
      )
      // Notifications from the deleted actor lose their handle (nothing to route to).
      const fromVictor = (await notificationsOf(db, alice.as)).filter(
        (n) => n.actorHumanId === victim.humanId,
      )
      expect(fromVictor.map((n) => n.type).sort()).toEqual(['direct_message', 'friend_live'])
      expect(fromVictor.every((n) => n.actorHandle === null)).toBe(true)
      // The freed handle can be claimed by someone else through identity_update.
      expect(await db.rpc('handle_available', { handle: 'victim1' }, bob.as)).toBe(true)
      expect(
        PublicIdentityDtoSchema.parse(
          await db.rpc('identity_update', { handle: 'victim1' }, bob.as),
        ).handle,
      ).toBe('victim1')
      await db.rpc('identity_update', { handle: 'bob' }, bob.as)
    })

    it('the credential is no Human any more: claiming, refused by Human RPCs, and may claim again as a new Human', async () => {
      expect(MeDtoSchema.parse(await db.rpc('me_get', {}, victim.as))).toMatchObject({
        roleKind: 'claiming',
        humanId: null,
        identity: null,
      })
      await db.expectError(
        db.rpc('identity_update', { display_name: 'Back' }, victim.as),
        'not_a_human',
      )
      await db.expectError(db.rpc('human_delete_request', {}, victim.as), 'not_a_human')
      await db.expectError(db.rpc('conversations_list', {}, victim.as), 'not_a_human')
      // Spec §80: nothing is restored — the normal claim creates a new pending Human.
      const started = await db.rpc<{ status: string; humanId: string }>(
        'claim_start',
        { intent: 'start_group', group_label: 'Second life', invite_token: null },
        victim.as,
      )
      expect(started.status).toBe('started')
      expect(started.humanId).not.toBe(victim.humanId)
      expect(
        await scalar<string>(db, 'status::text from public.humans where id = $1', [
          started.humanId,
        ]),
      ).toBe('pending')
      expect(
        await scalar<string>(db, 'status::text from public.humans where id = $1', [victim.humanId]),
      ).toBe('deleted')
      const link = (
        await db.sql.query<{ human_id: string; revoked_at: string | null }>(
          `select human_id, revoked_at from public.auth_identities where provider = 'supabase' and provider_subject = $1`,
          [victim.userId],
        )
      ).rows[0]
      expect(link).toEqual({ human_id: started.humanId, revoked_at: null })
      expect(await count(db, 'public.humans', 'auth_user_id = $1', [victim.userId])).toBe(1)
      // The old handle is free for the new claim as well.
      expect(await db.rpc('handle_available', { handle: 'victim1' }, victim.as)).toBe(true)
    })

    it('never a second Human while one is active: claim_start stays duplicate_human for a living credential', async () => {
      await db.expectError(
        db.rpc(
          'claim_start',
          { intent: 'start_group', group_label: 'Twice', invite_token: null },
          alice.as,
        ),
        'duplicate_human',
      )
      expect(await count(db, 'public.humans', 'auth_user_id = $1', [alice.userId])).toBe(1)
      // An unclaimed credential and a Guest are refused by the gate before anything is written.
      await db.expectError(
        db.rpc('human_delete_request', {}, (await createUnclaimed(db)).as),
        'not_a_human',
      )
      await db.expectError(
        db.rpc('human_delete_request', {}, (await createGuest(db)).as),
        'not_a_human',
      )
      await db.expectError(db.rpc('human_delete_request', {}, 'visitor'), 'not_authenticated')
    })
  })
})
