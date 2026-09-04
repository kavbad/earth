import { z } from 'zod'

import { REPORT_DETAILS_MAX } from '../constants'
import { ReportReasonSchema, ReportStatusSchema, ReportTargetTypeSchema } from '../enums'
import { HumanIdSchema } from '../ids'
import { IsoDateTimeSchema } from './common'

/** `report_create` (spec §41/§82). Humans and Guests may report. */
export const ReportInputSchema = z.object({
  targetType: ReportTargetTypeSchema,
  targetId: z.uuid(),
  reason: ReportReasonSchema,
  details: z.string().trim().max(REPORT_DETAILS_MAX).nullable(),
})
export type ReportInput = z.infer<typeof ReportInputSchema>

export const ReportDtoSchema = z.object({
  id: z.uuid(),
  status: ReportStatusSchema,
  createdAt: IsoDateTimeSchema,
})
export type ReportDto = z.infer<typeof ReportDtoSchema>

/** `blocks` (spec §21). Blocking overrides every form of discovery. */
export const BlockDtoSchema = z.object({
  blockerHumanId: HumanIdSchema,
  blockedHumanId: HumanIdSchema,
  createdAt: IsoDateTimeSchema,
})
export type BlockDto = z.infer<typeof BlockDtoSchema>

export const BlockInputSchema = z.object({
  humanId: HumanIdSchema,
})
export type BlockInput = z.infer<typeof BlockInputSchema>

export const BlocksListDtoSchema = z.object({
  blocks: z.array(BlockDtoSchema),
})
export type BlocksListDto = z.infer<typeof BlocksListDtoSchema>
