/**
 * Adversarial verification of the "social" invariant cluster (spec §20, §21, §56, §58, §128):
 *
 *   - Group member is not automatically Friend: shared membership unlocks nothing that friendship
 *     unlocks (friends posts, friends Lives, friend location shares, hidden profiles, friend_live).
 *   - Friend is not Follow: a follow edge unlocks nothing friend-gated, friendship writes no follow
 *     edge, and neither transition (request, accept, remove, decline) touches the other type.
 *   - `familiar_private` is hidden from its target on every surface that renders relations.
 *   - Blocks override every surface, including the sequences the straight-line tests do not try:
 *     a watching seat, an `invited` seat in a direct room, invite links and previews, replies
 *     inside a shared group, temporary group chats, group search, direct rooms.
 *
 * Every sequence is expressed as RPC calls by specific callers; raw rows only set up what no RPC
 * can (a `familiar_private` edge has no RPC in V1). One scratch database per file.
 */
import {
  GroupDetailDtoSchema,
  ProfileDtoSchema,
  RelationshipChangeDtoSchema,
  RoomDtoSchema,
  RoomInvitePreviewDtoSchema,
} from '@earth/domain'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import { POINTS, shareArgs } from '../geo/fixtures'
import {
  PERMISSION_DENIED,
  addMember,
  befriend,
  canSee,
  createGroup,
  createGuest,
  createHuman,
  createPost,
  createRoomInvite,
  createShare,
  createUnclaimed,
  directConversation,
  errorCode,
  feed,
  getRoom,
  human,
  joinRoom,
  notificationsFor,
  relate,
  resetAllRateLimits,
  search,
  sendMessage,
  startGroupRoom,
  startStandaloneRoom,
  visibleShares,
  type Human,
} from '../safety/fixtures'

interface LiveCandidateRow {
  roomId: string
  participants: Array<{ humanId: string | null; relationToViewer: string | null }>
}

async function liveRooms(db: TestDb, scope: string, as: RoleSpec): Promise<LiveCandidateRow[]> {
  const list = await db.rpc<{ candidates: LiveCandidateRow[] }>('live_candidates', { scope, area_id: null }, as)
  return list.candidates
}

async function liveRoomIds(db: TestDb, scope: string, as: RoleSpec): Promise<string[]> {
  return (await liveRooms(db, scope, as)).map((c) => c.roomId).sort()
}

async function rowsAs<T extends Record<string, unknown>>(db: TestDb, as: RoleSpec, sql: string, values: unknown[] = []): Promise<T[]> {
  return db.asRole(as, async (c) => (await c.query<T>(sql, values)).rows)
}

async function profile(db: TestDb, handle: string, as: RoleSpec) {
  return ProfileDtoSchema.parse(await db.rpc('profile_get', { handle }, as))
}

/** Relationship rows between two Humans as `ab:<type>` / `ba:<type>`, sorted. */
async function edges(db: TestDb, a: Human, b: Human): Promise<string[]> {
  const { rows } = await db.sql.query<{ edge: string }>(
    `select case when source_human_id = $1 then 'ab:' else 'ba:' end || type::text as edge
       from public.relationships
      where (source_human_id = $1 and target_human_id = $2) or (source_human_id = $2 and target_human_id = $1)
      order by 1`,
    [a.humanId, b.humanId],
  )
  return rows.map((r) => r.edge)
}

async function relationshipRowsAs(db: TestDb, as: RoleSpec, a: Human, b: Human): Promise<string[]> {
  const rows = await rowsAs<{ edge: string }>(
    db,
    as,
    `select case when source_human_id = $1 then 'ab:' else 'ba:' end || type::text as edge
       from public.relationships
      where source_human_id = any($2::uuid[]) and target_human_id = any($2::uuid[])
      order by 1`,
    [a.humanId, [a.humanId, b.humanId]],
  )
  return rows.map((r) => r.edge)
}

function liveTypes(rows: Awaited<ReturnType<typeof notificationsFor>>, roomId: string): string[] {
  return rows
    .filter((n) => ['friend_live', 'multi_live', 'group_live'].includes(n.type) && (n.payload as { roomId?: string }).roomId === roomId)
    .map((n) => n.type)
}

describe('social invariants — adversarial verification (spec §128)', () => {
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
  describe('group member is not automatically Friend', () => {
    let olive: Human
    let milo: Human
    let fiona: Human
    let hattie: Human
    let crew: { groupId: string; conversationId: string }

    beforeAll(async () => {
      olive = await human(db, 'Olive')
      milo = await human(db, 'Milo')
      fiona = await human(db, 'Fiona')
      hattie = await createHuman(db, { handle: 'hattiehidden', displayName: 'Hattie', visibility: 'hidden' })
      crew = await createGroup(db, olive, 'Olive Crew')
      await addMember(db, crew, milo)
      await addMember(db, crew, hattie)
      await befriend(db, olive, fiona)
      await befriend(db, fiona, hattie)
    })

    it('profile and member lists report shared membership, never friendship', async () => {
      const seenByMilo = await profile(db, olive.handle, milo.as)
      expect(seenByMilo.relationship).toMatchObject({ isFriend: false, friendRequest: 'none', isFollowing: false, isFollowedBy: false })
      expect(seenByMilo.sharedGroupCount).toBe(1)
      expect(seenByMilo.mutualFriendCount).toBe(0)
      expect(seenByMilo.counts.friends).toBe(1)
      const seenByFiona = await profile(db, olive.handle, fiona.as)
      expect(seenByFiona.relationship.isFriend).toBe(true)
      expect(seenByFiona.sharedGroupCount).toBe(0)

      const group = GroupDetailDtoSchema.parse(await db.rpc('group_get', { group_id: crew.groupId }, milo.as))
      const olivesRow = group.members.find((m) => m.humanId === olive.humanId)
      expect(olivesRow).toMatchObject({ role: 'owner', isFriend: false })
      // A group-mate who is also a friend is reported as one; membership itself never is.
      await befriend(db, olive, milo)
      const again = GroupDetailDtoSchema.parse(await db.rpc('group_get', { group_id: crew.groupId }, milo.as))
      expect(again.members.find((m) => m.humanId === olive.humanId)?.isFriend).toBe(true)
      await db.rpc('friend_remove', { other_human_id: olive.humanId }, milo.as)
      expect(await edges(db, olive, milo)).toEqual([])
    })

    it('a friends post is invisible to a group-mate on every read path; a friend sees it', async () => {
      const post = await createPost(db, olive, { audience: 'friends', text: 'olive friends only quokka' })
      const world = await createPost(db, olive, { audience: 'world', text: 'olive world wombat' })
      expect(await canSee(db, post.post.id, milo.as)).toBe(false)
      expect(await canSee(db, post.post.id, fiona.as)).toBe(true)
      expect(await rowsAs(db, milo.as, 'select id from public.posts where id = $1', [post.post.id])).toEqual([])
      await db.expectError(db.rpc('post_reaction_set', { post_id: post.post.id, reaction_type: 'like' }, milo.as), 'post_not_found')
      await db.expectError(db.rpc('post_create', { type: 'text', text: 'reply', audience: 'friends', parent_post_id: post.post.id }, milo.as), 'post_not_found')
      expect((await search(db, milo.as, 'quokka')).posts.map((p) => p.post.id)).not.toContain(post.post.id)
      expect((await search(db, fiona.as, 'quokka')).posts.map((p) => p.post.id)).toContain(post.post.id)

      // Feeds: the friends scope carries nothing from a shared-group stranger (spec §64); the world
      // scope carries the world post with relationship `shared_group`, never `friend`.
      const milosFriends = await feed(db, 'friends', milo.as)
      expect(milosFriends.candidates.map((c) => c.id)).not.toContain(post.post.id)
      expect(milosFriends.candidates.map((c) => c.id)).not.toContain(world.post.id)
      const milosWorld = await feed(db, 'world', milo.as)
      const card = milosWorld.candidates.find((c) => c.id === world.post.id)
      expect(card).toMatchObject({ relationship: 'shared_group', sharedGroupCount: 1 })
      const fionasFriends = await feed(db, 'friends', fiona.as)
      expect(fionasFriends.candidates.find((c) => c.id === post.post.id)).toMatchObject({ relationship: 'friend' })
    })

    it('a friends Live of a group-mate is invisible, unjoinable and unannounced; a group Live is not a friends Live', async () => {
      const miloBefore = (await notificationsFor(db, milo)).length
      const walk = await startStandaloneRoom(db, olive, 'Walk')
      const roomId = walk.room.id
      expect(walk.room).toMatchObject({ visibility: 'friends', joinPolicy: 'friends' })

      expect(await liveRoomIds(db, 'friends', milo.as)).not.toContain(roomId)
      await db.expectError(db.rpc('room_get', { room_id: roomId }, milo.as), 'room_not_found')
      await db.expectError(db.rpc('room_join', { room_id: roomId, media_state: 'camera', consent_level: 'friends' }, milo.as), 'room_not_found')
      await db.expectError(db.rpc('room_join', { room_id: roomId, media_state: 'watching', consent_level: 'invited' }, milo.as), 'room_not_found')
      expect(await rowsAs(db, milo.as, 'select id from public.rooms where id = $1', [roomId])).toEqual([])
      expect(await rowsAs(db, milo.as, 'select id from public.room_participants where room_id = $1', [roomId])).toEqual([])
      expect(await feed(db, 'friends', milo.as).then((f) => f.candidates.map((c) => c.id))).not.toContain(roomId)

      expect(await liveRoomIds(db, 'friends', fiona.as)).toContain(roomId)
      const fionasView = await getRoom(db, roomId, fiona.as)
      expect(fionasView.participants.map((p) => [p.humanId, p.relationToViewer])).toEqual([[olive.humanId, 'friend']])

      // friend_live went to the friend only.
      expect(liveTypes(await notificationsFor(db, fiona), roomId)).toEqual(['friend_live'])
      expect(liveTypes(await notificationsFor(db, milo), roomId)).toEqual([])
      expect((await notificationsFor(db, milo)).length).toBe(miloBefore)
      await db.rpc('room_end', { room_id: roomId }, olive.as)

      // The group's own Live: members see it through the group context with relation `shared_group`,
      // a friend outside the group does not, and the notification is group_live, not friend_live.
      const groupRoom = (await startGroupRoom(db, olive, crew, 'Dinner')).room.id
      const milosView = await getRoom(db, groupRoom, milo.as)
      expect(milosView.participants.map((p) => [p.humanId, p.relationToViewer])).toEqual([[olive.humanId, 'shared_group']])
      expect(liveTypes(await notificationsFor(db, milo), groupRoom)).toEqual(['group_live'])
      expect(await liveRoomIds(db, 'friends', fiona.as)).not.toContain(groupRoom)
      await db.expectError(db.rpc('room_get', { room_id: groupRoom }, fiona.as), 'room_not_found')
      expect(liveTypes(await notificationsFor(db, fiona), groupRoom)).toEqual([])
      await db.rpc('room_end', { room_id: groupRoom }, olive.as)
    })

    it('a friend location share cannot target a group-mate; a group share never becomes a friend share', async () => {
      expect(await errorCode(db.rpc('location_share_create', shareArgs({ audienceId: milo.humanId, position: POINTS.northBeach }), olive.as))).toBe('forbidden')
      const toFriend = await createShare(db, olive, { audienceId: fiona.humanId, position: POINTS.northBeach })
      const toGroup = await createShare(db, olive, { audienceType: 'group', audienceId: crew.groupId, precision: 'approximate', position: POINTS.northBeach })
      expect((await visibleShares(db, milo.as)).map((s) => s.shareId)).toEqual([toGroup.id])
      expect((await visibleShares(db, fiona.as)).map((s) => s.shareId)).toEqual([toFriend.id])
      await db.rpc('location_share_revoke', { share_id: toFriend.id }, olive.as)
      await db.rpc('location_share_revoke', { share_id: toGroup.id }, olive.as)
    })

    it('a hidden profile stays hidden from a group-mate (friends only)', async () => {
      await db.expectError(db.rpc('profile_get', { handle: hattie.handle }, milo.as), 'not_visible')
      expect(await rowsAs(db, milo.as, 'select human_id from public.public_identities where human_id = $1', [hattie.humanId])).toEqual([])
      expect((await search(db, milo.as, 'Hattie')).people.map((p) => p.humanId)).not.toContain(hattie.humanId)
      const seenByFriend = await profile(db, hattie.handle, fiona.as)
      expect(seenByFriend.identity.humanId).toBe(hattie.humanId)
      expect(await rowsAs(db, fiona.as, 'select human_id from public.public_identities where human_id = $1', [hattie.humanId])).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('Friend is not Follow', () => {
    let ann: Human
    let ben: Human
    let cy: Human

    beforeAll(async () => {
      ann = await human(db, 'Ann')
      ben = await human(db, 'Ben')
      cy = await human(db, 'Cy')
    })

    it('follow writes one directional edge and no friendship state', async () => {
      const followed = RelationshipChangeDtoSchema.parse(await db.rpc('follow_set', { target_human_id: ben.humanId, following: true }, ann.as))
      expect(followed).toMatchObject({ humanId: ben.humanId, isFollowing: true, isFriend: false, friendRequest: 'none' })
      expect(await edges(db, ann, ben)).toEqual(['ab:follow'])
      const bensView = await profile(db, ann.handle, ben.as)
      expect(bensView.relationship).toMatchObject({ isFriend: false, isFollowing: false, isFollowedBy: true, friendRequest: 'none' })
      const annsView = await profile(db, ben.handle, ann.as)
      expect(annsView.relationship).toMatchObject({ isFriend: false, isFollowing: true, isFollowedBy: false })
      expect(annsView.counts).toMatchObject({ friends: 0, followers: 1, following: 0 })
      expect(bensView.counts).toMatchObject({ friends: 0, followers: 0, following: 1 })
      expect((await search(db, ann.as, 'Ben')).people.find((p) => p.humanId === ben.humanId)).toMatchObject({ isFollowing: true, isFriend: false })
    })

    it('a follower gets nothing friend-gated: friends posts, friends Lives, friend_live, friend shares', async () => {
      const post = await createPost(db, ben, { audience: 'friends', text: 'ben friends only narwhal' })
      const world = await createPost(db, ben, { audience: 'world', text: 'ben world pelican' })
      expect(await canSee(db, post.post.id, ann.as)).toBe(false)
      await db.expectError(db.rpc('post_create', { type: 'text', text: 'reply', audience: 'friends', parent_post_id: post.post.id }, ann.as), 'post_not_found')
      const annsFriends = await feed(db, 'friends', ann.as)
      expect(annsFriends.candidates.map((c) => c.id)).not.toContain(post.post.id)
      // Followed Humans' public posts do belong to the friends pool (spec §64), tagged `follow`.
      expect(annsFriends.candidates.find((c) => c.id === world.post.id)).toMatchObject({ relationship: 'follow' })

      const annBefore = (await notificationsFor(db, ann)).length
      const run = await startStandaloneRoom(db, ben, 'Run')
      const roomId = run.room.id
      expect(await liveRoomIds(db, 'friends', ann.as)).not.toContain(roomId)
      await db.expectError(db.rpc('room_get', { room_id: roomId }, ann.as), 'room_not_found')
      await db.expectError(db.rpc('room_join', { room_id: roomId, media_state: 'camera', consent_level: 'friends' }, ann.as), 'room_not_found')
      expect(await rowsAs(db, ann.as, 'select id from public.rooms where id = $1', [roomId])).toEqual([])
      expect((await notificationsFor(db, ann)).length).toBe(annBefore)
      expect(liveTypes(await notificationsFor(db, ann), roomId)).toEqual([])
      await db.rpc('room_end', { room_id: roomId }, ben.as)

      expect(await errorCode(db.rpc('location_share_create', shareArgs({ audienceId: ann.humanId, position: POINTS.northBeach }), ben.as))).toBe('forbidden')
      expect(await errorCode(db.rpc('location_share_create', shareArgs({ audienceId: ben.humanId, position: POINTS.northBeach }), ann.as))).toBe('forbidden')
    })

    it('friendship writes friend rows only: no follow edge appears, in either direction', async () => {
      await db.rpc('friend_request_send', { target_human_id: cy.humanId }, ben.as)
      const accepted = RelationshipChangeDtoSchema.parse(await db.rpc('friend_request_accept', { source_human_id: ben.humanId }, cy.as))
      expect(accepted).toMatchObject({ isFriend: true, isFollowing: false, friendRequest: 'none' })
      expect(await edges(db, ben, cy)).toEqual(['ab:friend', 'ba:friend'])
      expect((await profile(db, cy.handle, ben.as)).relationship).toMatchObject({ isFriend: true, isFollowing: false, isFollowedBy: false })
      expect((await profile(db, ben.handle, cy.as)).relationship).toMatchObject({ isFriend: true, isFollowing: false, isFollowedBy: false })
      expect((await profile(db, ben.handle, cy.as)).counts).toMatchObject({ friends: 1, followers: 1, following: 0 })
      expect((await search(db, ben.as, 'Cy')).people.find((p) => p.humanId === cy.humanId)).toMatchObject({ isFriend: true, isFollowing: false })
      expect((await notificationsFor(db, cy)).filter((n) => n.actor_human_id === ben.humanId).map((n) => n.type)).toEqual(['friend_request'])
      expect((await notificationsFor(db, ben)).filter((n) => n.actor_human_id === cy.humanId).map((n) => n.type)).toEqual(['friend_accepted'])
    })

    it('request, accept, remove and decline never touch follow edges; unfollow never touches friendship', async () => {
      // ann follows ben (from the first test). The request rides alongside the follow.
      const sent = RelationshipChangeDtoSchema.parse(await db.rpc('friend_request_send', { target_human_id: ben.humanId }, ann.as))
      expect(sent).toMatchObject({ friendRequest: 'sent', isFollowing: true, isFriend: false })
      expect(await edges(db, ann, ben)).toEqual(['ab:follow', 'ab:friend_pending'])
      const accepted = RelationshipChangeDtoSchema.parse(await db.rpc('friend_request_accept', { source_human_id: ann.humanId }, ben.as))
      expect(accepted).toMatchObject({ isFriend: true, isFollowing: false })
      expect(await edges(db, ann, ben)).toEqual(['ab:follow', 'ab:friend', 'ba:friend'])
      expect((await profile(db, ben.handle, ann.as)).relationship).toMatchObject({ isFriend: true, isFollowing: true })

      const removed = RelationshipChangeDtoSchema.parse(await db.rpc('friend_remove', { other_human_id: ben.humanId }, ann.as))
      expect(removed).toMatchObject({ isFriend: false, isFollowing: true, friendRequest: 'none' })
      expect(await edges(db, ann, ben)).toEqual(['ab:follow'])

      // Unfollowing a friend keeps the friendship.
      await db.rpc('friend_request_send', { target_human_id: ben.humanId }, ann.as)
      await db.rpc('friend_request_accept', { source_human_id: ann.humanId }, ben.as)
      const unfollowed = RelationshipChangeDtoSchema.parse(await db.rpc('follow_set', { target_human_id: ben.humanId, following: false }, ann.as))
      expect(unfollowed).toMatchObject({ isFriend: true, isFollowing: false })
      expect(await edges(db, ann, ben)).toEqual(['ab:friend', 'ba:friend'])
      await db.rpc('friend_remove', { other_human_id: ben.humanId }, ann.as)

      // Declining a request from someone you follow keeps the follow.
      await db.rpc('follow_set', { target_human_id: ann.humanId, following: true }, cy.as)
      await db.rpc('friend_request_send', { target_human_id: cy.humanId }, ann.as)
      const declined = RelationshipChangeDtoSchema.parse(await db.rpc('friend_request_decline', { source_human_id: ann.humanId }, cy.as))
      expect(declined).toMatchObject({ isFriend: false, isFollowing: true, friendRequest: 'none' })
      expect(await edges(db, cy, ann)).toEqual(['ab:follow'])
      // A follow in the other direction does not turn a pending request into anything.
      await db.rpc('friend_request_send', { target_human_id: cy.humanId }, ann.as)
      expect(await edges(db, ann, cy)).toEqual(['ab:friend_pending', 'ba:follow'])
      expect((await profile(db, cy.handle, ann.as)).relationship).toMatchObject({ isFriend: false, friendRequest: 'sent', isFollowing: false, isFollowedBy: true })
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('familiar_private is hidden from its target', () => {
    let mara: Human
    let tom: Human
    let roomId: string

    beforeAll(async () => {
      mara = await human(db, 'Mara')
      tom = await human(db, 'Tom')
      await relate(db, mara, tom, 'familiar_private')
    })

    it('the target never reads the row; the source does; nobody can write rows directly', async () => {
      expect(await relationshipRowsAs(db, mara.as, mara, tom)).toEqual(['ab:familiar_private'])
      expect(await relationshipRowsAs(db, tom.as, mara, tom)).toEqual([])
      expect(await edges(db, mara, tom)).toEqual(['ab:familiar_private'])
      for (const as of [mara.as, tom.as]) {
        await expect(
          db.asRole(as, (c) => c.query("insert into public.relationships (source_human_id, target_human_id, type) values ($1, $2, 'familiar_private')", [tom.humanId, mara.humanId])),
        ).rejects.toMatchObject({ code: PERMISSION_DENIED })
        await expect(db.asRole(as, (c) => c.query('update public.relationships set type = $1', ['follow']))).rejects.toMatchObject({ code: PERMISSION_DENIED })
        await expect(db.asRole(as, (c) => c.query('delete from public.relationships'))).rejects.toMatchObject({ code: PERMISSION_DENIED })
      }
    })

    it('profiles expose no familiar flag in either direction', async () => {
      const bySource = await profile(db, tom.handle, mara.as)
      const byTarget = await profile(db, mara.handle, tom.as)
      const keys = ['isSelf', 'isFriend', 'friendRequest', 'isFollowing', 'isFollowedBy', 'isBlocked'].sort()
      expect(Object.keys(bySource.relationship).sort()).toEqual(keys)
      expect(Object.keys(byTarget.relationship).sort()).toEqual(keys)
      expect(byTarget.relationship).toEqual({ isSelf: false, isFriend: false, friendRequest: 'none', isFollowing: false, isFollowedBy: false, isBlocked: false })
      expect(byTarget.mutualFriendCount).toBe(0)
      expect(byTarget.sharedGroupCount).toBe(0)
    })

    it('room participant relations: the source sees `familiar`, the target sees `other`', async () => {
      const started = await startStandaloneRoom(db, mara, 'Open mic')
      roomId = started.room.id
      await db.rpc('room_set_visibility', { room_id: roomId, visibility: 'world' }, mara.as)
      const listed = (await liveRooms(db, 'world', tom.as)).find((c) => c.roomId === roomId)
      expect(listed?.participants.map((p) => [p.humanId, p.relationToViewer])).toEqual([[mara.humanId, 'other']])
      await joinRoom(db, roomId, tom, 'watching')
      const marasView = await getRoom(db, roomId, mara.as)
      expect(marasView.participants.find((p) => p.humanId === tom.humanId)?.relationToViewer).toBe('familiar')
      const tomsView = await getRoom(db, roomId, tom.as)
      expect(tomsView.participants.find((p) => p.humanId === mara.humanId)?.relationToViewer).toBe('other')
      expect(tomsView.participants.find((p) => p.humanId === tom.humanId)?.relationToViewer).toBe('self')
    })

    it('a block keeps the private edge private (it survives, still invisible to the target)', async () => {
      const blocked = await db.rpc<{ isBlocked: boolean }>('block_set', { target_human_id: tom.humanId }, mara.as)
      expect(blocked.isBlocked).toBe(true)
      expect(await edges(db, mara, tom)).toEqual(['ab:familiar_private'])
      expect(await relationshipRowsAs(db, tom.as, mara, tom)).toEqual([])
      expect(await relationshipRowsAs(db, mara.as, mara, tom)).toEqual(['ab:familiar_private'])
      // The block also cleared the shared seat (0360) and the room is gone for the target.
      await db.expectError(db.rpc('room_get', { room_id: roomId }, tom.as), 'room_not_found')
      await db.rpc('room_end', { room_id: roomId }, mara.as)
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('blocks override every surface — sequences beyond the straight line', () => {
    let alice: Human
    let bob: Human
    let carol: Human
    let crew: { groupId: string; conversationId: string }
    let aliceBobDm: string

    beforeAll(async () => {
      alice = await human(db, 'Alice')
      bob = await human(db, 'Bob')
      carol = await human(db, 'Carol')
      await befriend(db, alice, bob)
      await befriend(db, alice, carol)
      await befriend(db, bob, carol)
      crew = await createGroup(db, alice, 'Alice Crew')
      await addMember(db, crew, bob)
      await addMember(db, crew, carol)
      aliceBobDm = await directConversation(db, alice, bob)
      const result = await db.rpc<{ isBlocked: boolean; isFriend: boolean }>('block_set', { target_human_id: bob.humanId }, alice.as)
      expect(result).toMatchObject({ isBlocked: true, isFriend: false })
      await resetAllRateLimits(db)
    })

    it('a watching seat is still a seat: the blocked pair never shares a live room, in either order', async () => {
      // carol (friend of both) hosts; alice watches. The room must not exist for bob while alice
      // holds any seat — otherwise bob joins on camera and both end up face to face.
      const coffee = (await startStandaloneRoom(db, carol, 'Coffee')).room.id
      await joinRoom(db, coffee, alice, 'watching')
      expect(await liveRoomIds(db, 'friends', bob.as)).not.toContain(coffee)
      await db.expectError(db.rpc('room_get', { room_id: coffee }, bob.as), 'room_not_found')
      await db.expectError(db.rpc('room_join', { room_id: coffee, media_state: 'camera', consent_level: 'friends' }, bob.as), 'room_not_found')
      await db.expectError(db.rpc('room_join', { room_id: coffee, media_state: 'watching', consent_level: 'invited' }, bob.as), 'room_not_found')
      expect(await rowsAs(db, bob.as, 'select id from public.rooms where id = $1', [coffee])).toEqual([])
      const link = await createRoomInvite(db, coffee, carol)
      await db.expectError(db.rpc('room_invite_join', { token: link.token, media_state: 'watching', consent_level: 'invited' }, bob.as), 'room_not_found')
      expect((await getRoom(db, coffee, alice.as)).participants.map((p) => p.humanId).sort()).toEqual([alice.humanId, carol.humanId].sort())

      // Once alice leaves, bob may join; from then on the room is gone for alice, former seat or not.
      await db.rpc('room_leave', { room_id: coffee }, alice.as)
      expect(await liveRoomIds(db, 'friends', bob.as)).toContain(coffee)
      const bobsView = await joinRoom(db, coffee, bob, 'camera', 'friends')
      expect(bobsView.participants.map((p) => p.humanId).sort()).toEqual([bob.humanId, carol.humanId].sort())
      expect(await liveRoomIds(db, 'friends', alice.as)).not.toContain(coffee)
      await db.expectError(db.rpc('room_get', { room_id: coffee }, alice.as), 'room_not_found')
      await db.expectError(db.rpc('room_join', { room_id: coffee, media_state: 'watching', consent_level: 'invited' }, alice.as), 'room_not_found')
      await db.expectError(db.rpc('room_invite_join', { token: link.token, media_state: 'watching', consent_level: 'invited' }, alice.as), 'room_not_found')
      expect(await rowsAs(db, alice.as, 'select id from public.rooms where id = $1', [coffee])).toEqual([])
      // bob downgrading to watching changes nothing for alice: he still holds a seat.
      await db.rpc('room_set_media_state', { room_id: coffee, media_state: 'watching' }, bob.as)
      await db.expectError(db.rpc('room_get', { room_id: coffee }, alice.as), 'room_not_found')
      await db.expectError(db.rpc('room_join', { room_id: coffee, media_state: 'camera', consent_level: 'friends' }, alice.as), 'room_not_found')
      // carol, blocked with nobody, keeps everything.
      expect((await getRoom(db, coffee, carol.as)).participants.map((p) => p.humanId).sort()).toEqual([bob.humanId, carol.humanId].sort())
      await db.rpc('room_end', { room_id: coffee }, carol.as)
    })

    it('an invited seat in a direct room counts too: the link never seats the blocked Human, and the preview names nobody blocked', async () => {
      const dm = await directConversation(db, carol, alice)
      const direct = RoomDtoSchema.parse((await db.rpc<{ room: unknown }>('room_start', { context_type: 'direct', context_id: dm, title: null }, carol.as)).room)
      expect(direct.participants.map((p) => [p.humanId, p.status])).toEqual(expect.arrayContaining([[carol.humanId, 'active'], [alice.humanId, 'invited']]))
      const link = await createRoomInvite(db, direct.id, carol)

      await db.expectError(db.rpc('room_invite_join', { token: link.token, media_state: 'watching', consent_level: 'invited' }, bob.as), 'room_not_found')
      await db.expectError(db.rpc('room_invite_join', { token: link.token, media_state: 'camera', consent_level: 'invited' }, bob.as), 'room_not_found')
      expect(await rowsAs(db, bob.as, 'select id from public.rooms where id = $1', [direct.id])).toEqual([])
      const preview = RoomInvitePreviewDtoSchema.parse(await db.rpc('room_invite_preview', { token: link.token }, bob.as))
      expect(preview.participants.map((p) => p.displayName)).toEqual(['Carol'])
      expect(preview.contextTitle ?? '').not.toContain('Alice')
      expect(preview.invitedByDisplayName).toBe('Carol')

      // alice takes her seat and finds only carol.
      const alicesView = await joinRoom(db, direct.id, alice, 'camera', 'invited')
      expect(alicesView.participants.map((p) => p.humanId).sort()).toEqual([alice.humanId, carol.humanId].sort())
      expect(await rowsAs(db, bob.as, 'select id from public.room_participants where room_id = $1', [direct.id])).toEqual([])
      await db.rpc('room_end', { room_id: direct.id }, carol.as)
    })

    it('an invite link to the blocker’s own room reveals nothing and seats nobody; third parties are unaffected', async () => {
      const party = (await startStandaloneRoom(db, alice, 'Party')).room.id
      await db.rpc('room_set_visibility', { room_id: party, visibility: 'world' }, alice.as)
      const link = await createRoomInvite(db, party, alice)

      const forBob = RoomInvitePreviewDtoSchema.parse(await db.rpc('room_invite_preview', { token: link.token }, bob.as))
      expect(forBob.participants).toEqual([])
      expect(forBob.invitedByDisplayName).toBeNull()
      await db.expectError(db.rpc('room_invite_join', { token: link.token, media_state: 'watching', consent_level: 'invited' }, bob.as), 'room_not_found')
      expect(await liveRoomIds(db, 'world', bob.as)).not.toContain(party)

      const forCarol = RoomInvitePreviewDtoSchema.parse(await db.rpc('room_invite_preview', { token: link.token }, carol.as))
      expect(forCarol.participants.map((p) => p.displayName)).toEqual(['Alice'])
      expect(forCarol.invitedByDisplayName).toBe('Alice')
      const forVisitor = RoomInvitePreviewDtoSchema.parse(await db.rpc('room_invite_preview', { token: link.token }, 'visitor'))
      expect(forVisitor.participants.map((p) => p.displayName)).toEqual(['Alice'])
      expect(forVisitor.invitedByDisplayName).toBe('Alice')
      expect(await liveRoomIds(db, 'world', 'visitor')).toContain(party)
      await db.rpc('room_end', { room_id: party }, alice.as)
    })

    it('inside a shared group, replying to and reacting on the blocked Human’s messages is a direct interaction and is refused both ways', async () => {
      const fromAlice = await sendMessage(db, alice, crew.conversationId, 'hello crew')
      const fromCarol = await sendMessage(db, carol, crew.conversationId, 'hi all')
      const reply = (text: string, replyTo: string, as: RoleSpec) =>
        db.rpc('message_send', { conversation_id: crew.conversationId, client_id: randomUUID(), type: 'text', text, reply_to_message_id: replyTo }, as)
      expect(await errorCode(reply('quoting alice', fromAlice, bob.as))).toBe('blocked')
      expect(await errorCode(db.rpc('message_reaction_toggle', { message_id: fromAlice, reaction: '👍' }, bob.as))).toBe('blocked')
      const bobsReply = await reply('quoting carol', fromCarol, bob.as)
      expect(bobsReply).toMatchObject({ replyToMessageId: fromCarol })
      const fromBob = await sendMessage(db, bob, crew.conversationId, 'still here')
      expect(await errorCode(reply('quoting bob', fromBob, alice.as))).toBe('blocked')
      expect(await errorCode(db.rpc('message_reaction_toggle', { message_id: fromBob, reaction: '👍' }, alice.as))).toBe('blocked')
      expect(await errorCode(reply('quoting bob as carol', fromBob, carol.as))).toBeNull()
      // Nothing in the group conversation carries a reply across the block.
      const { rows } = await db.sql.query<{ n: string }>(
        `select count(*)::text as n
           from public.messages m
           join public.messages parent on parent.id = m.reply_to_message_id
          where m.conversation_id = $1
            and ((m.sender_human_id = $2 and parent.sender_human_id = $3) or (m.sender_human_id = $3 and parent.sender_human_id = $2))`,
        [crew.conversationId, alice.humanId, bob.humanId],
      )
      expect(Number(rows[0]?.n)).toBe(0)
    })

    it('temporary group chats cannot be created across the block by either side; a third party’s chat never notifies across it', async () => {
      await db.expectError(db.rpc('conversation_group_create', { human_ids: [alice.humanId, carol.humanId] }, bob.as), 'blocked')
      await db.expectError(db.rpc('conversation_group_create', { human_ids: [bob.humanId, carol.humanId] }, alice.as), 'blocked')
      const chat = await db.rpc<{ id: string }>('conversation_group_create', { human_ids: [alice.humanId, bob.humanId] }, carol.as)
      const aliceBefore = (await notificationsFor(db, alice)).filter((n) => n.actor_human_id === bob.humanId).length
      const carolBefore = (await notificationsFor(db, carol)).filter((n) => n.actor_human_id === bob.humanId).length
      await sendMessage(db, bob, chat.id, 'group hello')
      expect((await notificationsFor(db, alice)).filter((n) => n.actor_human_id === bob.humanId).length).toBe(aliceBefore)
      expect((await notificationsFor(db, carol)).filter((n) => n.actor_human_id === bob.humanId).length).toBe(carolBefore + 1)
      const queued = await db.rpc<Array<{ recipientHumanId: string; actorHumanId: string | null }>>('notifications_unsent', { limit: 500 }, 'service')
      expect(queued.filter((n) => n.recipientHumanId === alice.humanId && n.actorHumanId === bob.humanId)).toEqual([])
    })

    it('direct surfaces stay closed: direct rooms, the old DM, and group search across the block', async () => {
      await db.expectError(db.rpc('room_start', { context_type: 'direct', context_id: aliceBobDm, title: null }, bob.as), 'blocked')
      await db.expectError(db.rpc('room_start', { context_type: 'direct', context_id: aliceBobDm, title: null }, alice.as), 'blocked')
      await db.expectError(db.rpc('conversation_get', { conversation_id: aliceBobDm }, bob.as), 'blocked')
      const bobsList = await db.rpc<{ conversations: Array<{ id: string }> }>('conversations_list', {}, bob.as)
      expect(bobsList.conversations.map((c) => c.id)).not.toContain(aliceBobDm)
      expect(await rowsAs(db, bob.as, 'select id from public.messages where conversation_id = $1', [aliceBobDm])).toEqual([])

      expect((await search(db, bob.as, 'Alice Crew')).groups.map((g) => g.groupId)).not.toContain(crew.groupId)
      expect((await search(db, carol.as, 'Alice Crew')).groups.map((g) => g.groupId)).toContain(crew.groupId)
    })

    it('replies by the blocked pair under a third party’s post are hidden from each other', async () => {
      const root = await createPost(db, carol, { audience: 'world', text: 'carol world axolotl' })
      const byAlice = await createPost(db, alice, { audience: 'world', text: 'alice replies', parentPostId: root.post.id })
      const byBob = await createPost(db, bob, { audience: 'world', text: 'bob replies', parentPostId: root.post.id })
      const repliesFor = async (as: RoleSpec) =>
        (await db.rpc<{ replies: Array<{ post: { id: string } }> }>('post_replies', { post_id: root.post.id }, as)).replies.map((r) => r.post.id)
      expect(await repliesFor(bob.as)).toEqual([byBob.post.id])
      expect(await repliesFor(alice.as)).toEqual([byAlice.post.id])
      expect((await repliesFor(carol.as)).sort()).toEqual([byAlice.post.id, byBob.post.id].sort())
      expect(await canSee(db, byAlice.post.id, bob.as)).toBe(false)
      expect(await canSee(db, byBob.post.id, alice.as)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('authorization matrix: relationships and blocks per caller kind', () => {
    it('visitor denied; guest, claiming, friend, stranger and blocked see nothing of a pair; source and target see their own edges', async () => {
      const source = await human(db, 'Src')
      const target = await human(db, 'Tgt')
      const friend = await human(db, 'Fri')
      const stranger = await human(db, 'Str')
      const blockedBySource = await human(db, 'Blk')
      const guest = await createGuest(db)
      const claiming = await createUnclaimed(db)
      const pending = await createHuman(db, { handle: 'pendingmatrix', status: 'pending' })
      await befriend(db, source, friend)
      await relate(db, source, target, 'familiar_private')
      await relate(db, source, target, 'follow')
      await relate(db, target, source, 'friend_pending')
      await db.rpc('block_set', { target_human_id: blockedBySource.humanId }, source.as)

      await expect(db.asRole('visitor', (c) => c.query('select * from public.relationships'))).rejects.toMatchObject({ code: PERMISSION_DENIED })
      await expect(db.asRole('visitor', (c) => c.query('select * from public.blocks'))).rejects.toMatchObject({ code: PERMISSION_DENIED })
      for (const as of [guest.as, claiming.as, pending.as, friend.as, stranger.as, blockedBySource.as]) {
        expect(await relationshipRowsAs(db, as, source, target)).toEqual([])
        expect(await rowsAs(db, as, 'select blocker_human_id from public.blocks')).toEqual([])
      }
      expect(await relationshipRowsAs(db, source.as, source, target)).toEqual(['ab:familiar_private', 'ab:follow', 'ba:friend_pending'])
      expect(await relationshipRowsAs(db, target.as, source, target)).toEqual(['ab:follow', 'ba:friend_pending'])
      expect((await rowsAs(db, source.as, 'select blocked_human_id from public.blocks')).map((r) => r['blocked_human_id'])).toEqual([blockedBySource.humanId])
      // Only active Humans act; every other caller kind is refused before any row is touched.
      for (const rpc of ['friend_request_send', 'follow_set', 'block_set'] as const) {
        await db.expectError(db.rpc(rpc, { target_human_id: target.humanId }, 'visitor'), 'not_authenticated')
        await db.expectError(db.rpc(rpc, { target_human_id: target.humanId }, guest.as), 'not_a_human')
        await db.expectError(db.rpc(rpc, { target_human_id: target.humanId }, claiming.as), 'not_a_human')
        await db.expectError(db.rpc(rpc, { target_human_id: target.humanId }, pending.as), 'not_a_human')
      }
      await db.expectError(db.rpc('friend_request_send', { target_human_id: source.humanId }, blockedBySource.as), 'blocked')
      await db.expectError(db.rpc('follow_set', { target_human_id: source.humanId }, blockedBySource.as), 'blocked')
    })
  })
})
