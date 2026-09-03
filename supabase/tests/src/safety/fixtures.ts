/**
 * Shared fixtures for the safety database tests (Milestone 7: reports, blocks, rate limits, block
 * overrides). Reports go through the RPCs of 0720; Humans, edges, groups, rooms and posts reuse the
 * admission / rooms / posts / geo fixtures. Every helper parses RPC results with the domain DTOs.
 */
import {
  BlockDtoSchema,
  PublicIdentityDtoSchema,
  REPORT_REASON,
  REPORT_TARGET_TYPES,
  ReportDtoSchema,
  SearchResultsDtoSchema,
  type ReportReason,
  type ReportStatus,
  type ReportTargetType,
  type SearchResultsDto,
} from '@earth/domain'
import { z } from 'zod'

import type { RoleSpec, TestDb } from '../harness'
import type { Human } from '../admission/fixtures'

export {
  PERMISSION_DENIED,
  addMember,
  befriend,
  block,
  count,
  createArea,
  createGroup,
  createGuest,
  createHuman,
  createUnclaimed,
  isPermissionDenied,
  notificationsFor,
  relate,
  scalar,
  setFlag,
  setSetting,
  type GroupFixture,
  type Human,
} from '../admission/fixtures'
export {
  NIL_UUID,
  createGuestSession,
  createRoomInvite,
  directConversation,
  getRoom,
  human,
  joinRoom,
  participantId,
  rpcAt,
  secondsFromNow,
  setContext,
  startGroupRoom,
  startStandaloneRoom,
  type Guest,
} from '../rooms/fixtures'
export { createPost, feed, feedIds, getPost, canSee, type FeedResult } from '../posts/fixtures'
export { sendMessage } from '../notifications/fixtures'
export {
  BASE_AREA_SLUGS,
  POINTS,
  areaBySlug,
  createShare,
  shareRow,
  visibleShares,
} from '../geo/fixtures'

export type { ReportReason, ReportStatus, ReportTargetType }

/** What `report_create` / `reports_mine` / `report_resolve` return: `ReportDto` plus the report's own fields. */
export const ReportRowSchema = ReportDtoSchema.extend({
  targetType: z.enum(REPORT_TARGET_TYPES),
  targetId: z.uuid(),
  reason: z.enum(REPORT_REASON),
  details: z.string().nullable(),
  severity: z.enum(['high', 'normal']),
  resolvedAt: z.iso.datetime({ offset: true }).nullable(),
})
export type ReportRow = z.infer<typeof ReportRowSchema>

export const ReportsMineSchema = z.object({ reports: z.array(ReportRowSchema) })

/** `blocks_list()`: `BlocksListDto` where every block also carries the blocked identity. */
export const BlocksListWithIdentitiesSchema = z.object({
  blocks: z.array(BlockDtoSchema.extend({ identity: PublicIdentityDtoSchema.nullable() })),
})
export type BlocksListWithIdentities = z.infer<typeof BlocksListWithIdentitiesSchema>

export interface ReportInputArgs {
  targetType: ReportTargetType | string
  targetId: string | null
  reason?: ReportReason
  details?: string | null
}

export function reportArgs(input: ReportInputArgs): Record<string, unknown> {
  return {
    target_type: input.targetType,
    target_id: input.targetId,
    reason: input.reason ?? 'harassment',
    details: input.details ?? null,
  }
}

/** `report_create` as `as`, parsed. */
export async function createReport(
  db: TestDb,
  as: RoleSpec,
  input: ReportInputArgs,
): Promise<ReportRow> {
  return ReportRowSchema.parse(await db.rpc('report_create', reportArgs(input), as))
}

/** `report_create` that only cares about the error code (`null` when the call succeeded). */
export async function reportErrorCode(
  db: TestDb,
  as: RoleSpec,
  input: ReportInputArgs,
): Promise<string | null> {
  try {
    await db.rpc('report_create', reportArgs(input), as)
    return null
  } catch (error) {
    if (error instanceof Error) return error.message
    throw error
  }
}

export async function myReports(db: TestDb, as: RoleSpec): Promise<ReportRow[]> {
  return ReportsMineSchema.parse(await db.rpc('reports_mine', {}, as)).reports
}

export async function blocksList(db: TestDb, as: RoleSpec): Promise<BlocksListWithIdentities> {
  return BlocksListWithIdentitiesSchema.parse(await db.rpc('blocks_list', {}, as))
}

export async function resolveReport(
  db: TestDb,
  reportId: string,
  status: ReportStatus,
  as: RoleSpec = 'service',
): Promise<ReportRow> {
  return ReportRowSchema.parse(await db.rpc('report_resolve', { report_id: reportId, status }, as))
}

export interface ReportDbRow {
  reporter_kind: string
  reporter_human_id: string | null
  reporter_guest_session_id: string | null
  target_type: string
  target_id: string
  reason: string
  details: string | null
  status: string
  severity: string
  resolved_at: Date | null
}

export async function reportRow(db: TestDb, reportId: string): Promise<ReportDbRow | null> {
  const { rows } = await db.sql.query<ReportDbRow>(
    `select reporter_kind, reporter_human_id, reporter_guest_session_id, target_type, target_id,
            reason::text as reason, details, status::text as status, severity, resolved_at
       from public.reports where id = $1`,
    [reportId],
  )
  return rows[0] ?? null
}

export interface AuditRow {
  actor_human_id: string | null
  actor_role: string
  actor_auth_user_id: string | null
  action: string
  target_type: string
  target_id: string | null
  details: Record<string, unknown>
}

/** Audit rows for an action (newest last), optionally for one target. */
export async function auditRows(
  db: TestDb,
  action: string,
  targetId: string | null = null,
): Promise<AuditRow[]> {
  const { rows } = await db.sql.query<AuditRow>(
    `select actor_human_id, actor_role, actor_auth_user_id, action, target_type, target_id, details
       from private.audit_log
      where action = $1 and ($2::uuid is null or target_id = $2::uuid)
      order by id`,
    [action, targetId],
  )
  return rows
}

/** Clears the rate-limit windows of one subject through the service helper of 0730. */
export async function resetRateLimitsFor(
  db: TestDb,
  subject: string,
  action: string | null = null,
): Promise<number> {
  const { rows } = await db.sql.query<{ n: number }>('select earth.rate_limit_reset($1, $2) as n', [
    subject,
    action,
  ])
  return Number(rows[0]?.n ?? 0)
}

/** Clears every rate-limit window (each test file owns its scratch database). */
export async function resetAllRateLimits(db: TestDb): Promise<void> {
  await db.sql.query('delete from private.rate_limits')
}

export async function search(db: TestDb, as: RoleSpec, q: string): Promise<SearchResultsDto> {
  return SearchResultsDtoSchema.parse(await db.rpc('search', { q, limit: 10 }, as))
}

/** The error code a promise rejects with, or null when it resolves. */
export async function errorCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    if (error instanceof Error) return error.message
    throw error
  }
}

export function humanOf(human: Human): RoleSpec {
  return human.as
}
