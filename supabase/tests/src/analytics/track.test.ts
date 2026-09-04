/**
 * `analytics_track(events)` (spec §13, §96, §83; DB_API §8; 0800): identity comes from the
 * credential (never from the payload), Guest sessions attach only when owned by the caller,
 * reserved and coordinate-like properties never reach the table, malformed batches are refused
 * atomically, and the per-event budget (600 per 10 minutes, half for Guests and Visitors) holds.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  APP_VERSION,
  NIL_UUID,
  PLATFORM,
  TRACK_BATCH_MAX,
  TRACK_BUDGET,
  count,
  createGuest,
  createGuestSession,
  createHuman,
  createRoomInvite,
  createUnclaimed,
  event,
  eventRows,
  human,
  startStandaloneRoom,
  track,
  trackOne,
  visitorId,
  type Guest,
  type Human,
} from './fixtures'

const batch = (size: number, name = 'feed_opened'): ReturnType<typeof event>[] =>
  Array.from({ length: size }, (_, i) => event(name, { position: i }))

describe('analytics_track (spec §96–§97; DB_API §8)', () => {
  let db: TestDb
  let alice: Human
  let bob: Human

  beforeAll(async () => {
    db = await createTestDb()
    alice = await human(db, 'Alice')
    bob = await human(db, 'Bob')
  })

  afterAll(async () => {
    await db.drop()
  })

  describe('identity attribution', () => {
    it('visitor: anonymousVisitorId (top-level or merged into properties) is stored; nothing else', async () => {
      const visitor = visitorId()
      const topLevel = await trackOne(
        db,
        'visitor',
        event(
          'public_world_viewed',
          { surface: 'home', scope: 'world' },
          { anonymousVisitorId: visitor },
        ),
      )
      expect(topLevel).toMatchObject({
        human_id: null,
        anonymous_visitor_id: visitor,
        guest_session_id: null,
        name: 'public_world_viewed',
        platform: PLATFORM,
        app_version: APP_VERSION,
        client_timestamp: null,
      })
      expect(topLevel.properties).not.toHaveProperty('anonymousVisitorId')

      const merged = await trackOne(
        db,
        'visitor',
        event('claim_started', {
          entry: 'public_world',
          hasGroupInvite: false,
          anonymousVisitorId: visitor,
        }),
      )
      expect(merged.anonymous_visitor_id).toBe(visitor)
      expect(merged.properties).toEqual(
        expect.not.objectContaining({ anonymousVisitorId: expect.anything() }),
      )

      const bare = await trackOne(
        db,
        'visitor',
        event('feed_opened', { scope: 'world', surface: 'home', source: 'launch' }),
      )
      expect(bare).toMatchObject({
        human_id: null,
        anonymous_visitor_id: null,
        guest_session_id: null,
      })
    })

    it('a client-supplied humanId is never trusted: visitors stay anonymous, Humans are themselves', async () => {
      const spoofed = await trackOne(
        db,
        'visitor',
        event(
          'feed_opened',
          { scope: 'world', surface: 'home', source: 'launch', humanId: alice.humanId },
          { humanId: alice.humanId },
        ),
      )
      expect(spoofed.human_id).toBeNull()
      expect(spoofed.properties).not.toHaveProperty('humanId')

      const own = await trackOne(
        db,
        alice.as,
        event(
          'post_opened',
          { postId: NIL_UUID, source: 'home', humanId: bob.humanId },
          { humanId: bob.humanId, anonymousVisitorId: visitorId() },
        ),
      )
      expect(own.human_id).toBe(alice.humanId)
      expect(own.anonymous_visitor_id).not.toBeNull()
      expect(own.properties).toEqual({
        postId: NIL_UUID,
        source: 'home',
        marker: expect.any(String),
      })
    })

    it('claiming Humans are attributed to their pending Human; an unclaimed credential to nobody', async () => {
      const pending = await createHuman(db, {
        handle: 'pendingone',
        status: 'pending',
        identity: false,
      })
      const claimEvent = await trackOne(
        db,
        pending.as,
        event('claim_started', { entry: 'launch', hasGroupInvite: false }),
      )
      expect(claimEvent.human_id).toBe(pending.humanId)

      const unclaimed = await createUnclaimed(db)
      const unclaimedEvent = await trackOne(
        db,
        unclaimed.as,
        event('claim_started', { entry: 'launch', hasGroupInvite: false }),
      )
      expect(unclaimedEvent.human_id).toBeNull()

      const restricted = await createHuman(db, { handle: 'restrictedone', status: 'restricted' })
      const restrictedEvent = await trackOne(
        db,
        restricted.as,
        event('feed_opened', { scope: 'friends', surface: 'home', source: 'tab' }),
      )
      expect(restrictedEvent.human_id).toBe(restricted.humanId)
    })

    it('the service may call the RPC (no Human) and insert directly', async () => {
      const viaRpc = await trackOne(
        db,
        'service',
        event(
          'room_created',
          { roomId: NIL_UUID, contextType: 'group', visibility: 'group', joinPolicy: 'group' },
          { platform: 'server' },
        ),
      )
      expect(viaRpc).toMatchObject({ human_id: null, platform: 'server' })
      await db.sql.query(
        `insert into public.analytics_events (human_id, name, properties, platform, app_version)
         values ($1, 'group_created', '{"groupId": "00000000-0000-0000-0000-000000000000"}', 'server', '1.0.0')`,
        [alice.humanId],
      )
      expect(
        await count(db, 'public.analytics_events', "name = 'group_created' and human_id = $1", [
          alice.humanId,
        ]),
      ).toBe(1)
    })

    describe('guests', () => {
      let host: Human
      let roomA: string
      let roomB: string
      let guestA: Guest
      let guestB: Guest
      let sessionA: string
      let sessionB: string

      beforeAll(async () => {
        host = await human(db, 'Host')
        roomA = (await startStandaloneRoom(db, host, 'A')).room.id
        roomB = (await startStandaloneRoom(db, host, 'B')).room.id
        const inviteA = await createRoomInvite(db, roomA, host)
        const inviteB = await createRoomInvite(db, roomB, host)
        guestA = await createGuest(db)
        guestB = await createGuest(db)
        sessionA = (await createGuestSession(db, guestA, inviteA.token, 'Sam')).guestSessionId
        sessionB = (await createGuestSession(db, guestB, inviteB.token, 'Kim')).guestSessionId
      })

      it('attaches the supplied guestSessionId only when it belongs to the caller', async () => {
        const own = await trackOne(
          db,
          guestA.as,
          event('guest_joined', { roomId: roomA, guestSessionId: sessionA, mediaState: 'audio' }),
        )
        expect(own).toMatchObject({ human_id: null, guest_session_id: sessionA })
        // The property is data too (guest_* events name a session), so it stays.
        expect(own.properties['guestSessionId']).toBe(sessionA)

        const topLevel = await trackOne(
          db,
          guestA.as,
          event(
            'guest_room_completed',
            { durationMs: 10, outcome: 'left' },
            { guestSessionId: sessionA },
          ),
        )
        expect(topLevel.guest_session_id).toBe(sessionA)

        const foreign = await trackOne(
          db,
          guestB.as,
          event('guest_room_completed', {
            guestSessionId: sessionA,
            durationMs: 10,
            outcome: 'left',
          }),
        )
        expect(foreign.guest_session_id).toBeNull()
      })

      it('falls back to the caller session of properties.roomId; otherwise null', async () => {
        const byRoom = await trackOne(
          db,
          guestB.as,
          event('room_left', { roomId: roomB, durationMs: 5, reason: 'left' }),
        )
        expect(byRoom.guest_session_id).toBe(sessionB)
        const otherRoom = await trackOne(
          db,
          guestB.as,
          event('room_left', { roomId: roomA, durationMs: 5, reason: 'left' }),
        )
        expect(otherRoom.guest_session_id).toBeNull()
        const noRoom = await trackOne(
          db,
          guestB.as,
          event('guest_room_opened', { viewerState: 'guest' }),
        )
        expect(noRoom).toMatchObject({ human_id: null, guest_session_id: null })
        // A foreign id plus the caller's room: the room wins over the untrusted id.
        const mixed = await trackOne(
          db,
          guestB.as,
          event('guest_room_completed', {
            roomId: roomB,
            guestSessionId: sessionA,
            durationMs: 1,
            outcome: 'left',
          }),
        )
        expect(mixed.guest_session_id).toBe(sessionB)
      })

      it('a Guest supplying a malformed guestSessionId gets invalid_input; a Human never attaches one', async () => {
        await db.expectError(
          track(db, [event('guest_joined', { guestSessionId: 'garbage' })], guestA.as),
          'invalid_input',
        )
        const asHuman = await trackOne(
          db,
          alice.as,
          event(
            'human_claimed',
            { intent: 'join_group', guestSessionId: sessionA, durationMs: 100 },
            { guestSessionId: sessionA },
          ),
        )
        expect(asHuman).toMatchObject({ human_id: alice.humanId, guest_session_id: null })
        expect(asHuman.properties['guestSessionId']).toBe(sessionA)
      })
    })
  })

  describe('properties', () => {
    it('drops the reserved base and identity keys (guestSessionId stays) and reads platform/appVersion from them', async () => {
      const row = await trackOne(db, alice.as, {
        name: 'feed_opened',
        properties: {
          scope: 'friends',
          surface: 'home',
          source: 'tab',
          platform: 'ios',
          appVersion: '2.3.4',
          timestamp: '2026-09-03T10:00:00Z',
          humanId: bob.humanId,
          anonymousVisitorId: visitorId(),
          guestSessionId: NIL_UUID,
        },
      })
      expect(row).toMatchObject({
        platform: 'ios',
        app_version: '2.3.4',
        client_timestamp: '2026-09-03T10:00:00+00:00',
      })
      expect(Object.keys(row.properties).sort()).toEqual([
        'guestSessionId',
        'marker',
        'scope',
        'source',
        'surface',
      ])
    })

    it('strips keys that name a coordinate and values that read like one, recursively', async () => {
      const row = await trackOne(
        db,
        alice.as,
        event('post_created', {
          postId: NIL_UUID,
          type: 'text',
          audience: 'world',
          hasMedia: false,
          hasPlace: true,
          lat: 37.7749,
          lng: -122.4194,
          latitude: 37.7749,
          longitude: -122.4194,
          coords: [37.7749, -122.4194],
          coordinates: '37.7749,-122.4194',
          location: 'Dolores Park',
          userLat: 1,
          start_lng: 2,
          lat1: 3,
          latLng: '1,2',
          geoHash: 'abc',
          gps_fix: true,
          place: '37.7749,-122.4194',
          geoUri: 'geo:37.7749,-122.4194',
          tags: ['a', '37.7749,-122.4194'],
          nested: { latitude: 1, keep: true, deeper: { lon: 2, ok: 1 } },
          list: [{ lng: 1, a: 1 }, 'x'],
          deliveryLatencyMs: 12,
          position: 4,
          platformVersion: '17',
          roundish: '37.7,-122.4',
        }),
      )
      expect(row.properties).toEqual({
        marker: expect.any(String),
        postId: NIL_UUID,
        type: 'text',
        audience: 'world',
        hasMedia: false,
        hasPlace: true,
        nested: { keep: true, deeper: { ok: 1 } },
        list: [{ a: 1 }, 'x'],
        deliveryLatencyMs: 12,
        position: 4,
        platformVersion: '17',
        roundish: '37.7,-122.4',
      })
      expect(JSON.stringify(row.properties)).not.toMatch(/37\.7749|122\.4194/)
    })

    it('clientTimestamp: top-level wins over properties.timestamp; malformed values are refused', async () => {
      const both = await trackOne(
        db,
        alice.as,
        event(
          'feed_opened',
          { scope: 'city', surface: 'home', source: 'tab', timestamp: '2026-09-03T09:00:00Z' },
          { clientTimestamp: '2026-09-03T10:30:00.250+02:00' },
        ),
      )
      expect(both.client_timestamp).toBe('2026-09-03T08:30:00.25+00:00')
      const merged = await trackOne(
        db,
        alice.as,
        event('feed_opened', {
          scope: 'city',
          surface: 'home',
          source: 'tab',
          timestamp: '2026-09-03T09:00:00Z',
        }),
      )
      expect(merged.client_timestamp).toBe('2026-09-03T09:00:00+00:00')
      await db.expectError(
        track(db, [event('feed_opened', {}, { clientTimestamp: 'not-a-date' })], alice.as),
        'invalid_input',
      )
      await db.expectError(
        track(db, [event('feed_opened', {}, { clientTimestamp: 1725000000 })], alice.as),
        'invalid_input',
      )
    })
  })

  describe('validation (invalid_input)', () => {
    const cases: Array<[string, unknown]> = [
      ['an object instead of an array', { name: 'feed_opened' }],
      ['a string', 'feed_opened'],
      ['an empty array', []],
      ['51 events', batch(TRACK_BATCH_MAX + 1)],
      ['a non-object event', ['feed_opened']],
      ['properties that are not an object', [event('feed_opened', {}, { properties: ['x'] })]],
      ['a missing platform', [{ name: 'feed_opened', properties: {}, appVersion: '1' }]],
      ['an unknown platform', [event('feed_opened', {}, { platform: 'windows' })]],
      ['a non-string platform', [event('feed_opened', {}, { platform: 1 })]],
      ['a missing appVersion', [{ name: 'feed_opened', properties: {}, platform: 'web' }]],
      ['an empty appVersion', [event('feed_opened', {}, { appVersion: '' })]],
      ['a 65-character appVersion', [event('feed_opened', {}, { appVersion: 'v'.repeat(65) })]],
      ['a non-string appVersion', [event('feed_opened', {}, { appVersion: 1 })]],
      [
        'a non-uuid anonymousVisitorId',
        [event('feed_opened', {}, { anonymousVisitorId: 'device-1' })],
      ],
      [
        'a non-uuid anonymousVisitorId in properties',
        [event('feed_opened', { anonymousVisitorId: 12 })],
      ],
      [
        'more than 64 properties',
        [
          event(
            'feed_opened',
            Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i])),
          ),
        ],
      ],
    ]

    it.each(cases)('refuses %s', async (_label, events) => {
      await db.expectError(track(db, events, alice.as), 'invalid_input')
    })

    it('refuses a null argument and stores nothing from a partially valid batch', async () => {
      await db.expectError(track(db, null, alice.as), 'invalid_input')
      const before = await count(db, 'public.analytics_events')
      await db.expectError(
        track(
          db,
          [
            event('feed_opened', { marker: 'partial' }),
            event('feed_opened', {}, { platform: 'nope' }),
          ],
          alice.as,
        ),
        'invalid_input',
      )
      expect(await count(db, 'public.analytics_events')).toBe(before)
    })

    it('accepts exactly 50 events and a 64-character appVersion', async () => {
      expect(await track(db, batch(TRACK_BATCH_MAX), bob.as)).toEqual({ accepted: TRACK_BATCH_MAX })
      expect(
        await track(db, [event('feed_opened', {}, { appVersion: 'v'.repeat(64) })], bob.as),
      ).toEqual({ accepted: 1 })
    })
  })

  describe('rate limit (600 events / 10 min per Human, half for Guests and Visitors, never the service)', () => {
    const fill = async (
      as: RoleSpec,
      budget: number,
      headers?: Record<string, string>,
    ): Promise<void> => {
      for (let sent = 0; sent < budget; sent += TRACK_BATCH_MAX) {
        const size = Math.min(TRACK_BATCH_MAX, budget - sent)
        expect(await track(db, batch(size), as, headers === undefined ? {} : { headers })).toEqual({
          accepted: size,
        })
      }
    }

    it('a Human gets 600 events per window; the window rolls over', async () => {
      const limited = await human(db, 'Limited')
      await fill(limited.as, TRACK_BUDGET)
      await db.expectError(track(db, [event('feed_opened')], limited.as), 'rate_limited')
      expect(await count(db, 'public.analytics_events', 'human_id = $1', [limited.humanId])).toBe(
        TRACK_BUDGET,
      )
      // A refused batch never extends the window; 11 minutes later the budget is fresh.
      const later = new Date(Date.now() + 11 * 60 * 1000).toISOString()
      expect(await track(db, batch(TRACK_BATCH_MAX), limited.as, { at: later })).toEqual({
        accepted: TRACK_BATCH_MAX,
      })
    })

    it('a Visitor is keyed by client address with half the budget; another address is unaffected', async () => {
      const ip = { 'cf-connecting-ip': '203.0.113.10' }
      await fill('visitor', TRACK_BUDGET / 2, ip)
      await db.expectError(
        track(db, [event('feed_opened')], 'visitor', { headers: ip }),
        'rate_limited',
      )
      expect(
        await track(db, [event('feed_opened')], 'visitor', {
          headers: { 'cf-connecting-ip': '203.0.113.11' },
        }),
      ).toEqual({ accepted: 1 })
    })

    it('a Guest gets half the budget', async () => {
      const guest = await createGuest(db)
      await fill(guest.as, TRACK_BUDGET / 2)
      await db.expectError(track(db, [event('feed_opened')], guest.as), 'rate_limited')
    })

    it('the service is never limited', async () => {
      await fill('service', TRACK_BUDGET + TRACK_BATCH_MAX)
    })

    it('the batch cap and the budget are independent: 51 events are refused before any is charged', async () => {
      const fresh = await human(db, 'Fresh')
      await db.expectError(track(db, batch(TRACK_BATCH_MAX + 1), fresh.as), 'invalid_input')
      await fill(fresh.as, TRACK_BUDGET)
      expect((await eventRows(db, 'human_id = $1', [fresh.humanId])).length).toBe(TRACK_BUDGET)
    })
  })
})
