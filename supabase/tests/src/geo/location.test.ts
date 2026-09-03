/**
 * Location sharing (spec §39, §74–75, §128 "Exact location is never inferred as public permission";
 * DB_API §5): bounded, explicit, audience-scoped shares; write- and read-time precision
 * degradation; blocks, expiry, revocation and membership changes; the LOCATION_SHARING_ENABLED flag.
 */
import { LocationShareDtoSchema } from '@earth/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  BASE_AREA_SLUGS,
  NIL_UUID,
  POINTS,
  SF_CENTROID,
  addMember,
  areaBySlug,
  befriend,
  block,
  count,
  createGroup,
  createGuest,
  createHuman,
  createShare,
  createUnclaimed,
  expectedPosition,
  human,
  joinRoom,
  rpcAt,
  setFlag,
  shareArgs,
  shareRow,
  snapTo,
  startStandaloneRoom,
  storedPosition,
  visibleShares,
  type Human,
} from './fixtures'

const HOUR = 3600

describe('location sharing (DB_API §5)', () => {
  let db: TestDb
  let sf: string
  let alice: Human
  let bob: Human
  let carol: Human
  let guest: RoleSpec

  beforeAll(async () => {
    db = await createTestDb()
    sf = await areaBySlug(db, BASE_AREA_SLUGS.sanFrancisco)
    alice = await human(db, 'Alice')
    bob = await human(db, 'Bob')
    carol = await human(db, 'Carol')
    await befriend(db, alice, bob)
    guest = (await createGuest(db)).as
  })

  afterAll(async () => {
    await db.drop()
  })

  describe('location_share_create', () => {
    it('is for active Humans only', async () => {
      const args = shareArgs({ audienceId: bob.humanId })
      await db.expectError(db.rpc('location_share_create', args, 'visitor'), 'not_authenticated')
      await db.expectError(db.rpc('location_share_create', args, guest), 'not_a_human')
      const claiming = await createHuman(db, { handle: 'claiming', status: 'pending' })
      await db.expectError(db.rpc('location_share_create', args, claiming.as), 'not_a_human')
      await db.expectError(
        db.rpc('location_share_create', args, (await createUnclaimed(db)).as),
        'not_a_human',
      )
      await db.expectError(db.rpc('location_share_create', args, 'service'), 'not_a_human')
      const restricted = await createHuman(db, { handle: 'restricted', status: 'restricted' })
      await db.expectError(db.rpc('location_share_create', args, restricted.as), 'human_not_active')
    })

    it('rejects a duration over 24 hours (25h → invalid_input) and non-positive durations', async () => {
      await db.expectError(
        db.rpc(
          'location_share_create',
          shareArgs({ audienceId: bob.humanId, durationSeconds: 25 * HOUR }),
          alice.as,
        ),
        'invalid_input',
      )
      await db.expectError(
        db.rpc(
          'location_share_create',
          shareArgs({ audienceId: bob.humanId, durationSeconds: 0 }),
          alice.as,
        ),
        'invalid_input',
      )
      await db.expectError(
        db.rpc(
          'location_share_create',
          shareArgs({ audienceId: bob.humanId, durationSeconds: -60 }),
          alice.as,
        ),
        'invalid_input',
      )
      await db.expectError(
        db.rpc(
          'location_share_create',
          { ...shareArgs({ audienceId: bob.humanId }), duration_seconds: null },
          alice.as,
        ),
        'invalid_input',
      )
      // Exactly 24 hours is the maximum and is accepted.
      const day = await createShare(db, alice, {
        audienceId: bob.humanId,
        durationSeconds: 24 * HOUR,
      })
      expect(new Date(day.expiresAt).getTime() - new Date(day.createdAt).getTime()).toBe(
        24 * HOUR * 1000,
      )
      await db.rpc('location_share_revoke', { share_id: day.id }, alice.as)
      // The table itself refuses longer windows even for the owner of the database.
      await expect(
        db.sql.query(
          `insert into public.location_shares (human_id, audience_type, audience_id, precision, expires_at)
           values ($1, 'friend', $2, 'city', now() + interval '24 hours 1 second')`,
          [alice.humanId, bob.humanId],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    })

    it('requires LOCATION_SHARING_ENABLED', async () => {
      await setFlag(db, 'LOCATION_SHARING_ENABLED', false)
      try {
        await db.expectError(
          db.rpc('location_share_create', shareArgs({ audienceId: bob.humanId }), alice.as),
          'location_sharing_disabled',
        )
      } finally {
        await setFlag(db, 'LOCATION_SHARING_ENABLED', true)
      }
    })

    it('validates the position and the audience arguments', async () => {
      await db.expectError(
        db.rpc(
          'location_share_create',
          shareArgs({ audienceId: bob.humanId, position: { lat: 91, lng: 0 } }),
          alice.as,
        ),
        'invalid_input',
      )
      await db.expectError(
        db.rpc(
          'location_share_create',
          { ...shareArgs({ audienceId: bob.humanId }), lat: null },
          alice.as,
        ),
        'invalid_input',
      )
      await db.expectError(
        db.rpc(
          'location_share_create',
          { ...shareArgs({ audienceId: bob.humanId }), audience_id: null },
          alice.as,
        ),
        'invalid_input',
      )
      await db.expectError(
        db.rpc(
          'location_share_create',
          { ...shareArgs({ audienceId: bob.humanId }), precision: null },
          alice.as,
        ),
        'invalid_input',
      )
      await db.expectError(
        db.rpc('location_share_create', shareArgs({ audienceId: alice.humanId }), alice.as),
        'invalid_input',
      )
    })

    it('a friend share requires friendship (not blocked, other Human active)', async () => {
      await db.expectError(
        db.rpc('location_share_create', shareArgs({ audienceId: carol.humanId }), alice.as),
        'forbidden',
      )
      await db.expectError(
        db.rpc('location_share_create', shareArgs({ audienceId: NIL_UUID }), alice.as),
        'not_visible',
      )
      const pending = await createHuman(db, { handle: 'pendingfriend', status: 'pending' })
      await db.expectError(
        db.rpc('location_share_create', shareArgs({ audienceId: pending.humanId }), alice.as),
        'not_visible',
      )
      const blocker = await human(db, 'Blocker')
      await befriend(db, alice, blocker)
      await block(db, blocker, alice)
      await db.expectError(
        db.rpc('location_share_create', shareArgs({ audienceId: blocker.humanId }), alice.as),
        'blocked',
      )
    })

    it('a group share requires active membership of an active group', async () => {
      const group = await createGroup(db, carol, 'Crew')
      await db.expectError(
        db.rpc(
          'location_share_create',
          shareArgs({ audienceType: 'group', audienceId: group.groupId }),
          alice.as,
        ),
        'not_a_member',
      )
      await db.expectError(
        db.rpc(
          'location_share_create',
          shareArgs({ audienceType: 'group', audienceId: NIL_UUID }),
          alice.as,
        ),
        'group_not_found',
      )
      await addMember(db, group, alice)
      const share = await createShare(db, alice, {
        audienceType: 'group',
        audienceId: group.groupId,
        precision: 'approximate',
      })
      expect(share).toMatchObject({
        humanId: alice.humanId,
        audienceType: 'group',
        audienceId: group.groupId,
        precision: 'approximate',
      })
      await db.rpc('location_share_revoke', { share_id: share.id }, alice.as)
    })

    it('a temporary-context share requires being an active participant of a live Room', async () => {
      await db.expectError(
        db.rpc(
          'location_share_create',
          shareArgs({ audienceType: 'temporary_context', audienceId: NIL_UUID }),
          alice.as,
        ),
        'room_not_found',
      )
      const started = await startStandaloneRoom(db, carol)
      await db.expectError(
        db.rpc(
          'location_share_create',
          shareArgs({ audienceType: 'temporary_context', audienceId: started.room.id }),
          alice.as,
        ),
        'not_in_room',
      )
      await db.rpc('room_end', { room_id: started.room.id, reason: null }, carol.as)
      await db.expectError(
        db.rpc(
          'location_share_create',
          shareArgs({ audienceType: 'temporary_context', audienceId: started.room.id }),
          carol.as,
        ),
        'room_ended',
      )
    })

    it('returns a LocationShareDto, stores the initial position and replaces a live share to the same audience', async () => {
      const first = await createShare(db, alice, {
        audienceId: bob.humanId,
        precision: 'precise',
        durationSeconds: HOUR,
      })
      expect(LocationShareDtoSchema.parse(first)).toMatchObject({
        humanId: alice.humanId,
        audienceType: 'friend',
        audienceId: bob.humanId,
        precision: 'precise',
        revokedAt: null,
      })
      expect(new Date(first.expiresAt).getTime() - new Date(first.createdAt).getTime()).toBe(
        HOUR * 1000,
      )
      expect(await storedPosition(db, first.id)).toEqual({
        lat: POINTS.northBeach.lat,
        lng: POINTS.northBeach.lng,
        cityAreaId: sf,
      })

      const second = await createShare(db, alice, { audienceId: bob.humanId, precision: 'city' })
      expect(second.id).not.toBe(first.id)
      expect((await shareRow(db, first.id))?.revoked_at).not.toBeNull()
      expect(await storedPosition(db, first.id)).toBeNull()
      expect(
        await count(
          db,
          'public.location_shares',
          'human_id = $1 and audience_id = $2 and revoked_at is null',
          [alice.humanId, bob.humanId],
        ),
      ).toBe(1)
      await db.rpc('location_share_revoke', { share_id: second.id }, alice.as)
    })

    it('is rate limited (30 per hour)', async () => {
      const frank = await human(db, 'Frank')
      const grace = await human(db, 'Grace')
      await befriend(db, frank, grace)
      for (let i = 0; i < 30; i += 1) {
        await createShare(db, frank, { audienceId: grace.humanId })
      }
      await db.expectError(
        db.rpc('location_share_create', shareArgs({ audienceId: grace.humanId }), frank.as),
        'rate_limited',
      )
    })
  })

  describe('precision degradation (spec §74)', () => {
    const device = POINTS.northBeach

    for (const precision of ['precise', 'approximate', 'city'] as const) {
      it(`a ${precision} share is visible to the friend at ${precision} precision`, async () => {
        const share = await createShare(db, alice, {
          audienceId: bob.humanId,
          precision,
          position: device,
        })
        const expected = expectedPosition(precision, device, SF_CENTROID)
        const [visible] = await visibleShares(db, bob.as)
        expect(visible).toMatchObject({
          shareId: share.id,
          humanId: alice.humanId,
          displayName: 'Alice',
          avatarUrl: null,
          precision,
          audienceType: 'friend',
          audienceId: bob.humanId,
          expiresAt: share.expiresAt,
          lat: expected.lat,
          lng: expected.lng,
        })
        // The stored position never carries more precision than the share allows.
        expect(await storedPosition(db, share.id)).toEqual({
          lat: expected.lat,
          lng: expected.lng,
          cityAreaId: sf,
        })
        await db.rpc('location_share_revoke', { share_id: share.id }, alice.as)
      })
    }

    it('snaps approximate shares to a 0.01° grid and city shares to the city centroid, whatever is stored', async () => {
      expect(snapTo(37.80123, 2)).toBe(37.8)
      expect(snapTo(-122.41234, 2)).toBe(-122.41)
      expect(expectedPosition('approximate', { lat: 37.7596, lng: -122.427 }, null)).toEqual({
        lat: 37.76,
        lng: -122.43,
      })
      const share = await createShare(db, alice, {
        audienceId: bob.humanId,
        precision: 'approximate',
        position: { lat: 37.7596, lng: -122.427 },
      })
      // Even if a precise point were stored, the reader degrades it again.
      await db.sql.query(
        'update public.location_share_positions set location = st_setsrid(st_makepoint($2, $3), 4326) where share_id = $1',
        [share.id, -122.4271234, 37.7596789],
      )
      const [visible] = await visibleShares(db, bob.as)
      expect(visible).toMatchObject({ lat: 37.76, lng: -122.43 })
      await db.sql.query("update public.location_shares set precision = 'city' where id = $1", [
        share.id,
      ])
      const [asCity] = await visibleShares(db, bob.as)
      expect(asCity).toMatchObject({
        lat: SF_CENTROID.lat,
        lng: SF_CENTROID.lng,
        precision: 'city',
      })
      await db.rpc('location_share_revoke', { share_id: share.id }, alice.as)
    })

    it('a city share outside every known city falls back to a 0.1° cell', async () => {
      const share = await createShare(db, alice, {
        audienceId: bob.humanId,
        precision: 'city',
        position: POINTS.ocean,
      })
      expect(await storedPosition(db, share.id)).toEqual({
        lat: snapTo(POINTS.ocean.lat, 1),
        lng: snapTo(POINTS.ocean.lng, 1),
        cityAreaId: null,
      })
      const [visible] = await visibleShares(db, bob.as)
      expect(visible).toMatchObject({ lat: 0.1, lng: 0.5, precision: 'city' })
      await db.rpc('location_share_revoke', { share_id: share.id }, alice.as)
    })

    it('location_share_update moves the position (owner only) with the same degradation', async () => {
      const share = await createShare(db, alice, {
        audienceId: bob.humanId,
        precision: 'approximate',
        position: POINTS.northBeach,
      })
      const updated = LocationShareDtoSchema.parse(
        await db.rpc(
          'location_share_update',
          { share_id: share.id, lat: POINTS.mission.lat, lng: POINTS.mission.lng },
          alice.as,
        ),
      )
      expect(updated.id).toBe(share.id)
      const expected = expectedPosition('approximate', POINTS.mission, SF_CENTROID)
      expect(await storedPosition(db, share.id)).toEqual({
        lat: expected.lat,
        lng: expected.lng,
        cityAreaId: sf,
      })
      expect(await count(db, 'public.location_share_positions', 'share_id = $1', [share.id])).toBe(
        1,
      )
      const [visible] = await visibleShares(db, bob.as)
      expect(visible).toMatchObject({ lat: expected.lat, lng: expected.lng })

      await db.expectError(
        db.rpc('location_share_update', { share_id: share.id, lat: 1, lng: 2 }, bob.as),
        'not_visible',
      )
      await db.expectError(
        db.rpc('location_share_update', { share_id: share.id, lat: 1, lng: 2 }, carol.as),
        'not_visible',
      )
      await db.expectError(
        db.rpc('location_share_update', { share_id: NIL_UUID, lat: 1, lng: 2 }, alice.as),
        'not_visible',
      )
      await db.expectError(
        db.rpc('location_share_update', { share_id: share.id, lat: 100, lng: 2 }, alice.as),
        'invalid_input',
      )
      await db.expectError(
        db.rpc('location_share_update', { share_id: share.id, lat: 1, lng: 2 }, 'visitor'),
        'not_authenticated',
      )
      await db.expectError(
        db.rpc('location_share_update', { share_id: share.id, lat: 1, lng: 2 }, guest),
        'not_a_human',
      )

      await db.rpc('location_share_revoke', { share_id: share.id }, alice.as)
      await db.expectError(
        db.rpc('location_share_update', { share_id: share.id, lat: 1, lng: 2 }, alice.as),
        'invalid_input',
      )
      const expired = await createShare(db, alice, { audienceId: bob.humanId, durationSeconds: 60 })
      await db.expectError(
        rpcAt(
          db,
          'location_share_update',
          { share_id: expired.id, lat: 1, lng: 2 },
          alice.as,
          new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        ),
        'invalid_input',
      )
      await db.rpc('location_share_revoke', { share_id: expired.id }, alice.as)
    })
  })

  describe('who sees a friend share', () => {
    it('the friend sees it; a non-friend, the sharer and other callers do not', async () => {
      const share = await createShare(db, alice, { audienceId: bob.humanId })
      expect((await visibleShares(db, bob.as)).map((s) => s.shareId)).toEqual([share.id])
      expect(await visibleShares(db, carol.as)).toEqual([])
      expect(await visibleShares(db, alice.as)).toEqual([])
      // Another friend of Alice is not the audience.
      const dan = await human(db, 'Dan')
      await befriend(db, alice, dan)
      expect(await visibleShares(db, dan.as)).toEqual([])
      await db.expectError(db.rpc('location_shares_visible', {}, 'visitor'), 'not_authenticated')
      await db.expectError(db.rpc('location_shares_visible', {}, guest), 'not_a_human')
      await db.rpc('location_share_revoke', { share_id: share.id }, alice.as)
    })

    it('a revoked share disappears and loses its position; revoking is idempotent and owner-only', async () => {
      const share = await createShare(db, alice, { audienceId: bob.humanId })
      expect(await visibleShares(db, bob.as)).toHaveLength(1)
      await db.expectError(
        db.rpc('location_share_revoke', { share_id: share.id }, bob.as),
        'not_visible',
      )
      await db.expectError(
        db.rpc('location_share_revoke', { share_id: NIL_UUID }, alice.as),
        'not_visible',
      )
      await db.expectError(
        db.rpc('location_share_revoke', { share_id: share.id }, 'visitor'),
        'not_authenticated',
      )
      const revoked = LocationShareDtoSchema.parse(
        await db.rpc('location_share_revoke', { share_id: share.id }, alice.as),
      )
      expect(revoked.revokedAt).not.toBeNull()
      expect(await visibleShares(db, bob.as)).toEqual([])
      expect(await storedPosition(db, share.id)).toBeNull()
      const again = LocationShareDtoSchema.parse(
        await db.rpc('location_share_revoke', { share_id: share.id }, alice.as),
      )
      expect(again.revokedAt).toBe(revoked.revokedAt)
    })

    it('an expired share is invisible, and rooms_sweep revokes it and drops its position', async () => {
      const share = await createShare(db, alice, { audienceId: bob.humanId, durationSeconds: HOUR })
      const later = new Date(Date.now() + 2 * HOUR * 1000).toISOString()
      expect(await visibleShares(db, bob.as)).toHaveLength(1)
      expect(await rpcAt(db, 'location_shares_visible', {}, bob.as, later)).toEqual([])
      const swept = await rpcAt<{ locationSharesRevoked: number }>(
        db,
        'rooms_sweep',
        {},
        'service',
        later,
      )
      expect(swept.locationSharesRevoked).toBeGreaterThanOrEqual(1)
      expect((await shareRow(db, share.id))?.revoked_at).not.toBeNull()
      expect(await storedPosition(db, share.id)).toBeNull()
      expect(await visibleShares(db, bob.as)).toEqual([])
    })

    it('a block in either direction hides the share; block_set also revokes shares between the two', async () => {
      const share = await createShare(db, alice, { audienceId: bob.humanId })
      await block(db, bob, alice)
      expect(await visibleShares(db, bob.as)).toEqual([])
      await db.sql.query(
        'delete from public.blocks where blocker_human_id = $1 and blocked_human_id = $2',
        [bob.humanId, alice.humanId],
      )
      expect(await visibleShares(db, bob.as)).toHaveLength(1)
      await block(db, alice, bob)
      expect(await visibleShares(db, bob.as)).toEqual([])
      await db.sql.query(
        'delete from public.blocks where blocker_human_id = $1 and blocked_human_id = $2',
        [alice.humanId, bob.humanId],
      )
      expect(await visibleShares(db, bob.as)).toHaveLength(1)

      await db.rpc('block_set', { target_human_id: alice.humanId, blocked: true }, bob.as)
      expect((await shareRow(db, share.id))?.revoked_at).not.toBeNull()
      expect(await storedPosition(db, share.id)).toBeNull()
      expect(await visibleShares(db, bob.as)).toEqual([])
      await db.rpc('block_set', { target_human_id: alice.humanId, blocked: false }, bob.as)
      // Unblocking restores neither the friendship nor the share.
      expect(await visibleShares(db, bob.as)).toEqual([])
      await befriend(db, alice, bob)
    })

    it('ending the friendship or deactivating the sharer hides the share', async () => {
      const share = await createShare(db, alice, { audienceId: bob.humanId })
      await db.sql.query(
        `delete from public.relationships where type = 'friend'
          and ((source_human_id = $1 and target_human_id = $2) or (source_human_id = $2 and target_human_id = $1))`,
        [alice.humanId, bob.humanId],
      )
      expect(await visibleShares(db, bob.as)).toEqual([])
      await befriend(db, alice, bob)
      expect(await visibleShares(db, bob.as)).toHaveLength(1)
      await db.sql.query("update public.humans set status = 'suspended' where id = $1", [
        alice.humanId,
      ])
      expect(await visibleShares(db, bob.as)).toEqual([])
      await db.sql.query("update public.humans set status = 'active' where id = $1", [
        alice.humanId,
      ])
      await db.rpc('location_share_revoke', { share_id: share.id }, alice.as)
    })
  })

  describe('who sees a group share', () => {
    it('active members of the group only, while the sharer is a member', async () => {
      const owner = await human(db, 'Owner')
      const member = await human(db, 'Member')
      const outsider = await human(db, 'Outsider')
      const group = await createGroup(db, owner, 'Weekend Crew')
      await addMember(db, group, member)
      const share = await createShare(db, owner, {
        audienceType: 'group',
        audienceId: group.groupId,
        precision: 'approximate',
      })
      const expected = expectedPosition('approximate', POINTS.northBeach, SF_CENTROID)
      const [visible] = await visibleShares(db, member.as)
      expect(visible).toMatchObject({
        shareId: share.id,
        humanId: owner.humanId,
        audienceType: 'group',
        audienceId: group.groupId,
        ...expected,
      })
      expect(await visibleShares(db, outsider.as)).toEqual([])
      expect(await visibleShares(db, owner.as)).toEqual([])

      // A member who blocked the sharer (or vice versa) never sees it.
      await block(db, member, owner)
      expect(await visibleShares(db, member.as)).toEqual([])
      await db.sql.query('delete from public.blocks where blocker_human_id = $1', [member.humanId])
      expect(await visibleShares(db, member.as)).toHaveLength(1)

      // Leaving the group ends the audience; joining later grants it.
      await db.rpc('group_leave', { group_id: group.groupId }, member.as)
      expect(await visibleShares(db, member.as)).toEqual([])
      await addMember(db, group, outsider)
      expect((await visibleShares(db, outsider.as)).map((s) => s.shareId)).toEqual([share.id])

      // The sharer leaving the group hides the share from everyone.
      await db.sql.query(
        "update public.group_members set status = 'left', left_at = now() where group_id = $1 and human_id = $2",
        [group.groupId, owner.humanId],
      )
      expect(await visibleShares(db, outsider.as)).toEqual([])
    })
  })

  describe('who sees a temporary-context (Room) share', () => {
    it('active Human participants of the live Room only', async () => {
      const started = await startStandaloneRoom(db, alice)
      const roomId = started.room.id
      await joinRoom(db, roomId, bob, 'watching')
      const share = await createShare(db, alice, {
        audienceType: 'temporary_context',
        audienceId: roomId,
        precision: 'precise',
      })
      expect((await visibleShares(db, bob.as)).map((s) => s.shareId)).toEqual([share.id])
      expect(await visibleShares(db, carol.as)).toEqual([])
      await db.rpc('room_leave', { room_id: roomId }, bob.as)
      expect(await visibleShares(db, bob.as)).toEqual([])
      await joinRoom(db, roomId, bob, 'watching')
      expect(await visibleShares(db, bob.as)).toHaveLength(1)
      await db.rpc('room_end', { room_id: roomId, reason: null }, alice.as)
      expect(await visibleShares(db, bob.as)).toEqual([])
      await db.rpc('location_share_revoke', { share_id: share.id }, alice.as)
    })
  })

  describe('several shares at once', () => {
    it('lists every share that reaches the viewer, newest expiry first, each degraded on its own', async () => {
      const eve = await human(db, 'Eve')
      const finn = await human(db, 'Finn')
      await befriend(db, eve, finn)
      await befriend(db, bob, finn)
      const group = await createGroup(db, eve, 'Trio')
      await addMember(db, group, finn)
      const fromEve = await createShare(db, eve, {
        audienceType: 'group',
        audienceId: group.groupId,
        precision: 'city',
        durationSeconds: 3 * HOUR,
        position: POINTS.mission,
      })
      const fromBob = await createShare(db, bob, {
        audienceId: finn.humanId,
        precision: 'precise',
        durationSeconds: 2 * HOUR,
        position: POINTS.goldenGatePark,
      })
      const shares = await visibleShares(db, finn.as)
      expect(shares.map((s) => s.shareId)).toEqual([fromEve.id, fromBob.id])
      expect(shares[0]).toMatchObject({
        humanId: eve.humanId,
        precision: 'city',
        lat: SF_CENTROID.lat,
        lng: SF_CENTROID.lng,
      })
      expect(shares[1]).toMatchObject({
        humanId: bob.humanId,
        precision: 'precise',
        lat: POINTS.goldenGatePark.lat,
        lng: POINTS.goldenGatePark.lng,
      })
      // Nobody else sees Finn's view.
      expect(await visibleShares(db, carol.as)).toEqual([])
      await db.rpc('location_share_revoke', { share_id: fromEve.id }, eve.as)
      await db.rpc('location_share_revoke', { share_id: fromBob.id }, bob.as)
    })
  })
})
