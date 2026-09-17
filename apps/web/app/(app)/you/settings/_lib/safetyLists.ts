/**
 * Safety lists for SCREEN 25 (Safety): `blocks_list()` and `reports_mine()` return more than the
 * `@earth/domain` DTOs keep (`identity` per block, `targetType` / `reason` per report —
 * DB_API §7). The reads go through the EarthClient transport with a superset schema so the
 * screen can show who is blocked and what was reported without a second RPC.
 */
import { type EarthClient, RPC } from '@earth/api'
import {
  BlockDtoSchema,
  DisplayNameSchema,
  HandleSchema,
  HumanIdSchema,
  IsoDateTimeSchema,
  NullableUrlSchema,
  ReportDtoSchema,
  ReportReasonSchema,
  ReportTargetTypeSchema,
} from '@earth/domain'
import { z } from 'zod'

export const BlockedIdentitySchema = z.object({
  humanId: HumanIdSchema,
  displayName: DisplayNameSchema,
  handle: HandleSchema.nullish(),
  avatarUrl: NullableUrlSchema.optional(),
})

export const BlockedHumanSchema = BlockDtoSchema.extend({
  identity: BlockedIdentitySchema.nullish(),
})
export type BlockedHuman = z.infer<typeof BlockedHumanSchema>

export const BlocksWithIdentitySchema = z.union([
  z.object({ blocks: z.array(BlockedHumanSchema) }),
  z.array(BlockedHumanSchema).transform((blocks) => ({ blocks })),
])

export const ReportHistoryItemSchema = ReportDtoSchema.extend({
  targetType: ReportTargetTypeSchema.nullish(),
  targetId: z.string().nullish(),
  reason: ReportReasonSchema.nullish(),
  resolvedAt: IsoDateTimeSchema.nullish(),
})
export type ReportHistoryItem = z.infer<typeof ReportHistoryItemSchema>

export const ReportsWithDetailSchema = z.union([
  z.object({ reports: z.array(ReportHistoryItemSchema) }),
  z.array(ReportHistoryItemSchema).transform((reports) => ({ reports })),
])

export async function listBlockedHumans(earth: EarthClient): Promise<BlockedHuman[]> {
  const result = await earth.transport.rpc(RPC.blocksList, {}, BlocksWithIdentitySchema)
  return result.blocks
}

export async function listMyReports(earth: EarthClient): Promise<ReportHistoryItem[]> {
  const result = await earth.transport.rpc(RPC.reportsMine, {}, ReportsWithDetailSchema)
  return result.reports
}
