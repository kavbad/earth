/**
 * The SQL event whitelist is exactly `EVENT_NAMES` (spec §97; packages/analytics/src/contract.ts):
 * same names, same order, nothing more, and `analytics_track` accepts every entry while refusing
 * anything else with `invalid_input` (DB_API §8).
 */
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type TestDb } from '../harness'
import {
  EVENT_CATEGORIES,
  EVENT_NAMES,
  TRACK_BATCH_MAX,
  count,
  event,
  human,
  track,
  type Human,
} from './fixtures'

const CHECK_VIOLATION = '23514'

describe('analytics event whitelist = EVENT_NAMES (spec §97; DB_API §8)', () => {
  let db: TestDb
  let alice: Human

  beforeAll(async () => {
    db = await createTestDb()
    alice = await human(db, 'Alice')
  })

  afterAll(async () => {
    await db.drop()
  })

  it('earth.analytics_event_names() is EVENT_NAMES, in spec order, without duplicates', async () => {
    const { rows } = await db.sql.query<{ name: string }>(
      `select n.name from unnest(earth.analytics_event_names()) with ordinality as n(name, ord) order by n.ord`,
    )
    expect(rows.map((row) => row.name)).toEqual([...EVENT_NAMES])
    expect(new Set(rows.map((row) => row.name)).size).toBe(EVENT_NAMES.length)
    // The grouped contract and the flat list agree, so the SQL list covers every category.
    const grouped = Object.values(EVENT_CATEGORIES).flatMap((names) => [...names])
    expect([...grouped].sort()).toEqual([...EVENT_NAMES].sort())
    for (const name of EVENT_NAMES) {
      const { rows: allowed } = await db.sql.query<{ ok: boolean }>(
        'select earth.analytics_event_name_allowed($1) as ok',
        [name],
      )
      expect(allowed[0]?.ok, name).toBe(true)
    }
  })

  it('analytics_track accepts every EVENT_NAMES entry', async () => {
    for (let index = 0; index < EVENT_NAMES.length; index += TRACK_BATCH_MAX) {
      const batch = EVENT_NAMES.slice(index, index + TRACK_BATCH_MAX).map((name) =>
        event(name, { batch: index }),
      )
      expect(await track(db, batch, alice.as)).toEqual({ accepted: batch.length })
    }
    const { rows } = await db.sql.query<{ name: string; n: number }>(
      `select name, count(*)::int as n from public.analytics_events
        where human_id = $1 group by name order by name`,
      [alice.humanId],
    )
    expect(rows.map((row) => row.name)).toEqual([...EVENT_NAMES].sort())
    expect(rows.every((row) => row.n === 1)).toBe(true)
  })

  it('rejects unknown, miscased, blank, missing and non-string names with invalid_input', async () => {
    for (const name of ['nope', 'Room_Joined', 'room joined', '', ' room_joined', 'room_joined ']) {
      await db.expectError(track(db, [event(name)], alice.as), 'invalid_input')
    }
    await db.expectError(
      track(db, [{ properties: {}, platform: 'web', appVersion: '1.0.0' }], alice.as),
      'invalid_input',
    )
    await db.expectError(track(db, [{ ...event('room_joined'), name: 5 }], alice.as), 'invalid_input')
    await db.expectError(track(db, [{ ...event('room_joined'), name: null }], alice.as), 'invalid_input')
  })

  it('one unknown name fails the whole batch (nothing is stored)', async () => {
    const before = await count(db, 'public.analytics_events')
    await db.expectError(
      track(db, [event('room_joined', { marker: 'atomic' }), event('unknown_event')], alice.as),
      'invalid_input',
    )
    expect(await count(db, 'public.analytics_events')).toBe(before)
    expect(await count(db, 'public.analytics_events', "properties ->> 'marker' = 'atomic'")).toBe(0)
  })

  it('the table refuses names outside the whitelist even for direct service inserts', async () => {
    let failure: unknown
    try {
      await db.sql.query(
        `insert into public.analytics_events (name, platform, app_version) values ('nope', 'server', '1.0.0')`,
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(pg.DatabaseError)
    expect((failure as pg.DatabaseError).code).toBe(CHECK_VIOLATION)
    await db.sql.query(
      `insert into public.analytics_events (name, platform, app_version) values ('room_joined', 'server', '1.0.0')`,
    )
    expect(await count(db, 'public.analytics_events', "platform = 'server'")).toBe(1)
  })
})
