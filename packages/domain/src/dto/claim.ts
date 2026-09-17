import { z } from 'zod'

import {
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_MIN,
  GROUP_NAME_MAX,
  HANDLE_MAX_LENGTH,
  HANDLE_MIN_LENGTH,
  HANDLE_REGEX,
} from '../constants'
import { ClaimIntentSchema, ClaimStatusSchema, HumanPassStatusSchema } from '../enums'
import { ConversationIdSchema, GroupIdSchema, HumanIdSchema } from '../ids'
import { IsoDateTimeSchema, NullableUrlSchema } from './common'

export const HandleSchema = z
  .string()
  .min(HANDLE_MIN_LENGTH)
  .max(HANDLE_MAX_LENGTH)
  .regex(HANDLE_REGEX)
export type Handle = z.infer<typeof HandleSchema>

export const DisplayNameSchema = z.string().trim().min(DISPLAY_NAME_MIN).max(DISPLAY_NAME_MAX)

export const ClaimIdentityDtoSchema = z.object({
  displayName: DisplayNameSchema,
  handle: HandleSchema,
  avatarUrl: NullableUrlSchema,
})
export type ClaimIdentityDto = z.infer<typeof ClaimIdentityDtoSchema>

export const ClaimVerificationDtoSchema = z.object({
  status: HumanPassStatusSchema,
  sessionId: z.string().min(1).optional(),
})
export type ClaimVerificationDto = z.infer<typeof ClaimVerificationDtoSchema>

/** Current claim-flow state for a Claiming Human (`humans.status = 'pending'`). */
export const ClaimStateDtoSchema = z.object({
  status: ClaimStatusSchema,
  intent: ClaimIntentSchema,
  groupLabel: z.string().max(GROUP_NAME_MAX).nullable(),
  inviteToken: z.string().min(1).nullish(),
  identity: ClaimIdentityDtoSchema.nullish(),
  verification: ClaimVerificationDtoSchema,
  humanId: HumanIdSchema,
})
export type ClaimStateDto = z.infer<typeof ClaimStateDtoSchema>

/** Result of `claim_complete`: Human + group + owner membership + conversation in one transaction (spec §45). */
export const ClaimCompleteDtoSchema = z.object({
  humanId: HumanIdSchema,
  groupId: GroupIdSchema,
  conversationId: ConversationIdSchema,
})
export type ClaimCompleteDto = z.infer<typeof ClaimCompleteDtoSchema>

/** Result of `POST /api/claim/verification/start` and `GET /api/claim/verification/:sessionId`. */
export const VerificationSessionDtoSchema = z.object({
  sessionId: z.string().min(1),
  status: HumanPassStatusSchema,
  /** Vendor-hosted step URL when the provider needs one; `null` for mock/manual review. */
  providerUrl: NullableUrlSchema,
  expiresAt: IsoDateTimeSchema.nullable(),
})
export type VerificationSessionDto = z.infer<typeof VerificationSessionDtoSchema>

export const ClaimStartInputSchema = z
  .object({
    intent: ClaimIntentSchema,
    groupLabel: z.string().trim().max(GROUP_NAME_MAX).nullish(),
    inviteToken: z.string().min(1).nullish(),
  })
  .refine((input) => input.intent !== 'join_group' || typeof input.inviteToken === 'string', {
    message: 'join_group requires inviteToken',
    path: ['inviteToken'],
  })
export type ClaimStartInput = z.infer<typeof ClaimStartInputSchema>

export const ClaimIdentityInputSchema = z.object({
  displayName: DisplayNameSchema,
  handle: HandleSchema,
  avatarMediaId: z.uuid().nullish(),
})
export type ClaimIdentityInput = z.infer<typeof ClaimIdentityInputSchema>
