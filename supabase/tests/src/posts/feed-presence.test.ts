/**
 * `feed_presence()` (DB_API §4; spec PART VI SCREEN 02 "Presence row: render only when there is
 * meaningful state. Examples: 'Xavier + Maya live', 'Weekend Crew · 3 active', 'Sarah nearby'").
 *
 * The RPC returns the three raw sources only — the labels and the naming live in `@earth/domain`
 * and are assembled by `packages/server/src/feed/presence.ts`.
 */
import { PRESENCE_ROW_WINDOW_MINUTES } from '@earth/domain'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  addMember,
  befriend,
  block,
  createArea,
  createGroup,
  createGuest,
  createHuman,
  human,
  setContext,
  setHuman,
  setSetting,
  startGroupRoom,
  startStandaloneRoom,
  type GroupFixture,
  type Human,
} from './fixtures'

const PresenceResultSchema = z.object({
  liveRooms: z.array(
    z.object({
      roomId: z.uuid(),
      contextType: z.string(),
      startedAt: z.iso.datetime({ offset: true }),
      participants: z.array(
        z.object({
          humanId: z.uuid().nullable(),
          displayName: z.string().min(1),
          mediaState: z.string(),
          relationToViewer: z.string().nullable(),
        }),
      ),
    }),
  ),
  activeGroups: z.array(
    z.object({
      groupId: z.uuid(),
      groupName: z.string().min(1),
      conversationId: z.uuid().nullable(),
      activeCount: z.int().min(0),
      humanIds: z.array(z.uuid()),
      avatarUrls: z.array(z.string().nullable()),
    }),
  ),
  nearbyFriends: z.array(
    z.object({
      humanId: z.uuid(),
      displayName: z.string().min(1),
      avatarUrl: z.string().nullable(),
    }),
  ),
})
type PresenceResult = z.infer<typeof PresenceResultSchema>

async function presence(db: TestDb, as: RoleSpec): Promise<PresenceResult> {
  return PresenceResultSchema.parse(await db.rpc('feed_presence', {}, as))
}

/** A `human_presence` row as `presence_ping` would leave it, `minutesAgo` in the past. */
async function ping(
  db: TestDb,
  who: Human,
  options: { conversationId?: string | null; minutesAgo?: number } = {},
): Promise<void> {
  await db.sql.query(
    `insert into public.human_presence (human_id, last_active_at, active_conversation_id)
     values ($1, now() - make_interval(mins => $3::int), $2)
     on conflict on constraint human_presence_pkey do update
       set last_active_at = excluded.last_active_at,
           active_conversation_id = excluded.active_conversation_id`,
    [who.humanId, options.conversationId ?? null, options.minutesAgo ?? 0],
  )
}

describe('feed_presence (SCREEN 02 presence row)', () => {
  let db: TestDb
  let sf: string
  let mission: string
  let marina: string
  let me: Human
  let friend: Human
  let otherFriend: Human
  let groupmate: Human
  let stranger: Human
  let blockedFriend: Human
  let group: GroupFixture
  let otherGroup: GroupFixture
  let unnamedGroup: GroupFixture

  beforeAll(async () => {
    db = await createTestDb()
    sf = await createArea(db, { name: 'San Francisco', slug: 'sf', type: 'city' })
    mission = await createArea(db, {
      name: 'Mission',
      slug: 'mission',
      type: 'neighborhood',
      parentAreaId: sf,
    })
    marina = await createArea(db, {
      name: 'Marina',
      slug: 'marina',
      type: 'neighborhood',
      parentAreaId: sf,
    })
    me = await human(db, 'Me')
    friend = await human(db, 'Xavier')
    otherFriend = await human(db, 'Sarah')
    groupmate = await human(db, 'Groupmate')
    stranger = await human(db, 'Stranger')
    blockedFriend = await human(db, 'Blockedfriend')
    await befriend(db, me, friend)
    await befriend(db, me, otherFriend)
    await befriend(db, me, blockedFriend)
    await block(db, me, blockedFriend)
    group = await createGroup(db, me, 'Weekend Crew')
    await addMember(db, group, groupmate)
    otherGroup = await createGroup(db, stranger, 'Not Mine')
    await addMember(db, otherGroup, groupmate)
    unnamedGroup = await createGroup(db, me, null)
    await addMember(db, unnamedGroup, groupmate)
    await setContext(db, me, { currentAreaId: mission, currentCityId: sf })
  })

  afterAll(async () => {
    await db.drop()
  })

  beforeEach(async () => {
    await db.sql.query('delete from public.human_presence')
    await db.sql.query(
      `update public.rooms
          set status = 'ended', ended_at = now(), active_human_count = 0, active_participant_count = 0
        where status in ('starting', 'active')`,
    )
    await setContext(db, me, { currentAreaId: mission, currentCityId: sf })
  })

  it('has nothing to show when nothing is happening', async () => {
    expect(await presence(db, me.as)).toEqual({
      liveRooms: [],
      activeGroups: [],
      nearbyFriends: [],
    })
  })

  it('is empty (never an error) for visitors and Guests, who have no presence', async () => {
    expect(await presence(db, 'visitor')).toEqual({
      liveRooms: [],
      activeGroups: [],
      nearbyFriends: [],
    })
    const guest = await createGuest(db)
    expect(await presence(db, guest.as)).toEqual({
      liveRooms: [],
      activeGroups: [],
      nearbyFriends: [],
    })
  })

  it('returns the Friends-radius Lives with each publisher’s relation to the viewer', async () => {
    const friendsLive = await startStandaloneRoom(db, friend, 'Cooking')
    const groupLive = await startGroupRoom(db, groupmate, group)
    const strangerLive = await startStandaloneRoom(db, stranger)

    const result = await presence(db, me.as)
    const roomIds = result.liveRooms.map((room) => room.roomId)
    expect(roomIds).toContain(friendsLive.room.id)
    expect(roomIds).toContain(groupLive.room.id)
    expect(roomIds).not.toContain(strangerLive.room.id)

    const row = result.liveRooms.find((room) => room.roomId === friendsLive.room.id)
    expect(row?.participants).toEqual([
      expect.objectContaining({
        humanId: friend.humanId,
        displayName: 'Xavier',
        relationToViewer: 'friend',
      }),
    ])
  })

  it('counts the members of the caller’s named groups who are in the group’s conversation', async () => {
    await ping(db, groupmate, { conversationId: group.conversationId })
    await ping(db, friend, { conversationId: group.conversationId })
    await addMember(db, group, friend)

    const result = await presence(db, me.as)
    expect(result.activeGroups).toHaveLength(1)
    expect(result.activeGroups[0]).toMatchObject({
      groupId: group.groupId,
      groupName: 'Weekend Crew',
      conversationId: group.conversationId,
      activeCount: 2,
    })
    expect(result.activeGroups[0]?.humanIds.sort()).toEqual(
      [groupmate.humanId, friend.humanId].sort(),
    )
  })

  it('never counts the caller, another conversation, a stale ping, a group the caller is not in, or an unnamed group', async () => {
    // The caller's own presence is not "3 active" to the caller.
    await ping(db, me, { conversationId: group.conversationId })
    // Present, but reading a different conversation.
    await ping(db, groupmate, { conversationId: unnamedGroup.conversationId })
    expect((await presence(db, me.as)).activeGroups).toEqual([])

    // Present in a group the caller does not belong to.
    await ping(db, groupmate, { conversationId: otherGroup.conversationId })
    expect((await presence(db, me.as)).activeGroups).toEqual([])

    // In the caller's group but outside the presence window.
    await ping(db, groupmate, {
      conversationId: group.conversationId,
      minutesAgo: PRESENCE_ROW_WINDOW_MINUTES + 1,
    })
    expect((await presence(db, me.as)).activeGroups).toEqual([])

    // Inside it: the same row now counts, so only the window separated the two.
    await ping(db, groupmate, {
      conversationId: group.conversationId,
      minutesAgo: PRESENCE_ROW_WINDOW_MINUTES - 1,
    })
    expect((await presence(db, me.as)).activeGroups).toMatchObject([{ activeCount: 1 }])
  })

  it('lists friends present in the caller’s current area, and nobody else', async () => {
    await setContext(db, otherFriend, { currentAreaId: mission, currentCityId: sf })
    await setContext(db, friend, { currentAreaId: marina, currentCityId: sf })
    await setContext(db, stranger, { currentAreaId: mission, currentCityId: sf })
    await setContext(db, blockedFriend, { currentAreaId: mission, currentCityId: sf })
    await ping(db, otherFriend)
    await ping(db, friend)
    await ping(db, stranger)
    await ping(db, blockedFriend)

    const result = await presence(db, me.as)
    expect(result.nearbyFriends).toEqual([
      expect.objectContaining({ humanId: otherFriend.humanId, displayName: 'Sarah' }),
    ])
  })

  it('drops a nearby friend whose ping is outside the window, and one who left the area', async () => {
    await setContext(db, otherFriend, { currentAreaId: mission, currentCityId: sf })
    await ping(db, otherFriend, { minutesAgo: PRESENCE_ROW_WINDOW_MINUTES + 1 })
    expect((await presence(db, me.as)).nearbyFriends).toEqual([])

    await ping(db, otherFriend, { minutesAgo: PRESENCE_ROW_WINDOW_MINUTES - 1 })
    expect((await presence(db, me.as)).nearbyFriends).toHaveLength(1)

    await setContext(db, otherFriend, { currentAreaId: marina, currentCityId: sf })
    expect((await presence(db, me.as)).nearbyFriends).toEqual([])
  })

  it('has no nearby row at all when the caller has no current area', async () => {
    await setContext(db, otherFriend, { currentAreaId: mission, currentCityId: sf })
    await ping(db, otherFriend)
    await setContext(db, me, { currentAreaId: null, currentCityId: sf })
    expect((await presence(db, me.as)).nearbyFriends).toEqual([])
  })

  it('hides fixture Humans in production', async () => {
    await setContext(db, otherFriend, { currentAreaId: mission, currentCityId: sf })
    await ping(db, otherFriend)
    await ping(db, groupmate, { conversationId: group.conversationId })
    const live = await startStandaloneRoom(db, friend)
    expect((await presence(db, me.as)).nearbyFriends).toHaveLength(1)

    await setHuman(db, otherFriend, { isFixture: true })
    await setHuman(db, groupmate, { isFixture: true })
    await setHuman(db, friend, { isFixture: true })
    await setSetting(db, 'environment', 'production')
    try {
      const result = await presence(db, me.as)
      expect(result.nearbyFriends).toEqual([])
      expect(result.activeGroups).toEqual([])
      expect(result.liveRooms.map((room) => room.roomId)).not.toContain(live.room.id)
    } finally {
      await setSetting(db, 'environment', 'development')
      await setHuman(db, otherFriend, { isFixture: false })
      await setHuman(db, groupmate, { isFixture: false })
      await setHuman(db, friend, { isFixture: false })
    }
  })

  it('is callable by every API role and reveals nothing to an unrelated Human', async () => {
    await ping(db, groupmate, { conversationId: group.conversationId })
    await setContext(db, otherFriend, { currentAreaId: mission, currentCityId: sf })
    await ping(db, otherFriend)
    const outsider = await createHuman(db, { handle: 'outsider', displayName: 'Outsider' })
    await setContext(db, outsider, { currentAreaId: mission, currentCityId: sf })
    expect(await presence(db, outsider.as)).toEqual({
      liveRooms: [],
      activeGroups: [],
      nearbyFriends: [],
    })
  })
})
