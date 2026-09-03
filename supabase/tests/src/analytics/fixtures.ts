/**
 * Shared fixtures for the analytics / metrics database tests (spec §13, PART XVI–XVII; DB_API §8;
 * migrations 0800–0820). Events go through `analytics_track`; Humans, groups and rooms reuse the
 * admission and rooms fixtures. The event contract is imported by relative path the way
 * `../domain.ts` imports the enum registry: this package declares no `@earth/analytics` dependency.
 */
import { randomUUID } from 'node:crypto'
import pg from 'pg'

import { unwrapRpcResult, type RoleSpec, type TestDb } from '../harness'

export { EVENT_CATEGORIES, EVENT_NAMES } from '../../../../packages/analytics/src/contract'
export {
  PERMISSION_DENIED,
  addMember,
  befriend,
  block,
  count,
  createGroup,
  createGuest,
  createHuman,
  createInvite,
  createUnclaimed,
  isPermissionDenied,
  scalar,
  setFlag,
  type GroupFixture,
  type Human,
} from '../admission/fixtures'
export {
  createGuestSession,
  createRoomInvite,
  human,
  joinRoom,
  roomRow,
  rpcAt,
  startGroupRoom,
  startStandaloneRoom,
  type Guest,
} from '../rooms/fixtures'

export const PLATFORM = 'web'
export const APP_VERSION = '1.0.0'
export const NIL_UUID = '00000000-0000-0000-0000-000000000000'
/** Per-event budget of `analytics_track` for a Human (0800); Guests and Visitors get half. */
export const TRACK_BUDGET = 600
export const TRACK_BATCH_MAX = 50

export type TrackEvent = Record<string, unknown> & { name: string }

/** A well-formed envelope; `extra` overrides or adds top-level keys. */
export function event(
  name: string,
  properties: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): TrackEvent {
  return { name, properties, platform: PLATFORM, appVersion: APP_VERSION, ...extra }
}

export function visitorId(): string {
  return randomUUID()
}

export interface TrackOptions {
  /** Simulated PostgREST request headers (Visitor rate-limit key is `cf-connecting-ip`). */
  headers?: Record<string, string>
  /** Freeze `earth.utc_now()` at this instant for the call. */
  at?: string
}

/** `analytics_track(events)` as the caller. `events` is passed as JSON text so arrays survive. */
export async function track(
  db: TestDb,
  events: unknown,
  as: RoleSpec,
  options: TrackOptions = {},
): Promise<{ accepted: number }> {
  return db.asRole(as, async (client) => {
    if (options.headers !== undefined) {
      await client.query(`select set_config('request.headers', $1, true)`, [
        JSON.stringify(options.headers),
      ])
    }
    if (options.at !== undefined) {
      await client.query(`select set_config('earth.now', $1, true)`, [options.at])
    }
    const result = await client.query('select * from public.analytics_track(events => $1)', [
      events === null ? null : JSON.stringify(events),
    ])
    return unwrapRpcResult(result) as { accepted: number }
  })
}

export interface EventRow {
  id: string
  human_id: string | null
  anonymous_visitor_id: string | null
  guest_session_id: string | null
  name: string
  properties: Record<string, unknown>
  platform: string
  app_version: string
  client_timestamp: string | null
  created_at: string
}

export async function eventRows(db: TestDb, where = 'true', values: unknown[] = []): Promise<EventRow[]> {
  const { rows } = await db.sql.query<EventRow>(
    `select id, human_id, anonymous_visitor_id, guest_session_id, name, properties, platform, app_version,
            to_json(client_timestamp)::text as client_timestamp, to_json(created_at)::text as created_at
       from public.analytics_events where ${where} order by created_at, id`,
    values,
  )
  return rows.map((row) => ({
    ...row,
    client_timestamp: row.client_timestamp === null ? null : JSON.parse(row.client_timestamp),
    created_at: JSON.parse(row.created_at) as string,
  }))
}

/** Tracks one event and returns the stored row (matched by a unique marker property). */
export async function trackOne(
  db: TestDb,
  as: RoleSpec,
  envelope: TrackEvent,
  options: TrackOptions = {},
): Promise<EventRow> {
  const marker = randomUUID()
  const properties = { ...((envelope['properties'] as Record<string, unknown> | undefined) ?? {}), marker }
  const result = await track(db, [{ ...envelope, properties }], as, options)
  if (result.accepted !== 1) throw new Error(`expected 1 accepted event, got ${result.accepted}`)
  const rows = await eventRows(db, "properties ->> 'marker' = $1", [marker])
  const row = rows[0]
  if (row === undefined || rows.length !== 1) throw new Error('tracked event not found')
  return row
}

export interface DiagnosticRow {
  id: string
  human_id: string | null
  guest_session_id: string | null
  room_id: string | null
  kind: string
  payload: Record<string, unknown>
}

export async function diagnosticRows(db: TestDb, where = 'true', values: unknown[] = []): Promise<DiagnosticRow[]> {
  const { rows } = await db.sql.query<DiagnosticRow>(
    `select id, human_id, guest_session_id, room_id, kind, payload
       from public.rtc_diagnostics where ${where} order by created_at, id`,
    values,
  )
  return rows
}

/** Runs `sql` as the caller inside a rolled-back transaction and returns the thrown error, if any. */
export async function attempt(
  db: TestDb,
  as: RoleSpec,
  sql: string,
  values: unknown[] = [],
): Promise<unknown> {
  try {
    await db.asRole(as, (client) => client.query(sql, values), { rollback: true })
    return undefined
  } catch (error) {
    return error
  }
}

export function sqlstate(error: unknown): string | undefined {
  return error instanceof pg.DatabaseError ? error.code : undefined
}

export async function setCreatedAt(db: TestDb, table: string, id: string, at: string): Promise<void> {
  await db.sql.query(`update ${table} set created_at = $2 where id = $1`, [id, at])
}

/** A metric row as stored: `value` parsed to a number (or null). */
export interface MetricRow {
  day: string
  metric: string
  dimensions: Record<string, unknown>
  value: number | null
  details: Record<string, unknown>
  computed_at: string
}

export async function metricRows(db: TestDb, day: string): Promise<MetricRow[]> {
  const { rows } = await db.sql.query<MetricRow & { value: string | null }>(
    `select day::text as day, metric, dimensions, value::text as value, details,
            to_json(computed_at) #>> '{}' as computed_at
       from public.metrics_daily where day = $1 order by metric, dimensions::text`,
    [day],
  )
  return rows.map((row) => ({ ...row, value: row.value === null ? null : Number(row.value) }))
}

export function metricKey(metric: string, dimensions: Record<string, unknown> = {}): string {
  return `${metric}|${JSON.stringify(dimensions)}`
}

export async function metricMap(db: TestDb, day: string): Promise<Map<string, MetricRow>> {
  const map = new Map<string, MetricRow>()
  for (const row of await metricRows(db, day)) map.set(metricKey(row.metric, row.dimensions), row)
  return map
}
