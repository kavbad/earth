/**
 * The mandatory V1 controls (spec §81) per target and the §82 report target, pure so the safety
 * menu is tested without providers: every post — Report, Hide, Block author; every Human profile —
 * Block (or Unblock), Report; every room — Leave, Report; every Guest — Remove, block from this
 * room (moderators), Report. Also the Settings → Safety lists (`blocks_list()` with identities,
 * `reports_mine()` with target and reason), read through the typed client's transport with a
 * superset schema of the `@earth/domain` DTOs (DB_API §7).
 */
import type { ClaimEntryPoint, SourceSurface } from '@earth/analytics'
import { type EarthClient, RPC } from '@earth/api'
import {
  BlockDtoSchema,
  DisplayNameSchema,
  type GuestSessionId,
  HandleSchema,
  type HumanId,
  HumanIdSchema,
  IsoDateTimeSchema,
  NullableUrlSchema,
  type PostId,
  ReportDtoSchema,
  ReportReasonSchema,
  type ReportTargetType,
  ReportTargetTypeSchema,
  type RoomId,
} from '@earth/domain'
import { copy } from '@earth/ui'
import { z } from 'zod'

import { safetyCopy } from '../copy'

export type SafetyTarget =
  | {
      readonly kind: 'post'
      readonly postId: PostId
      readonly authorHumanId: HumanId
      readonly authorDisplayName: string
      /** Own posts get Report only from elsewhere (delete lives with the post); nothing here. */
      readonly isOwn?: boolean
    }
  | {
      readonly kind: 'profile'
      readonly humanId: HumanId
      readonly displayName: string
      readonly isBlocked: boolean
    }
  | {
      readonly kind: 'room'
      readonly roomId: RoomId
      readonly title: string
      /** `false` while the person is not in the room (a card, a preview). */
      readonly canLeave: boolean
    }
  | {
      readonly kind: 'guest'
      readonly roomId: RoomId
      readonly participantId: string
      readonly guestSessionId: GuestSessionId
      readonly displayName: string
      /** Only moderators remove; everyone may report. */
      readonly canModerate: boolean
    }

export const SAFETY_ACTION_KEYS = [
  'report',
  'hide',
  'block',
  'unblock',
  'leave',
  'remove',
  'removeAndBlock',
] as const
export type SafetyActionKey = (typeof SAFETY_ACTION_KEYS)[number]

export interface SafetyAction {
  readonly key: SafetyActionKey
  readonly label: string
  readonly destructive: boolean
}

/** Spec §81, in the spec's order per target. */
export function safetyActionsFor(target: SafetyTarget): readonly SafetyAction[] {
  switch (target.kind) {
    case 'post':
      if (target.isOwn === true) return []
      return [
        { key: 'report', label: copy.safety.report, destructive: false },
        { key: 'hide', label: copy.safety.hide, destructive: false },
        { key: 'block', label: copy.safety.blockAuthor, destructive: true },
      ]
    case 'profile':
      return [
        target.isBlocked
          ? { key: 'unblock', label: copy.safety.unblock, destructive: false }
          : { key: 'block', label: copy.safety.block, destructive: true },
        { key: 'report', label: copy.safety.report, destructive: false },
      ]
    case 'room':
      return [
        ...(target.canLeave
          ? [{ key: 'leave', label: copy.safety.leave, destructive: false } as const]
          : []),
        { key: 'report', label: copy.safety.report, destructive: false },
      ]
    case 'guest':
      return [
        ...(target.canModerate
          ? ([
              { key: 'remove', label: copy.safety.remove, destructive: true },
              { key: 'removeAndBlock', label: safetyCopy.removeAndBlock, destructive: true },
            ] as const)
          : []),
        { key: 'report', label: copy.safety.report, destructive: false },
      ]
    default: {
      const exhaustive: never = target
      throw new Error(`Unknown safety target: ${String(exhaustive)}`)
    }
  }
}

/** What the target's Report sends (`report_create.target_type`). */
export function reportTargetFor(target: SafetyTarget): {
  readonly type: ReportTargetType
  readonly id: string
} {
  switch (target.kind) {
    case 'post':
      return { type: 'post', id: target.postId }
    case 'profile':
      return { type: 'human', id: target.humanId }
    case 'room':
      return { type: 'room', id: target.roomId }
    case 'guest':
      return { type: 'guest', id: target.guestSessionId }
    default: {
      const exhaustive: never = target
      throw new Error(`Unknown safety target: ${String(exhaustive)}`)
    }
  }
}

export function claimEntryFor(source: SourceSurface): ClaimEntryPoint {
  switch (source) {
    case 'post':
      return 'post'
    case 'profile':
      return 'profile'
    default:
      return 'public_world'
  }
}

/** Who a Human or Guest may block from the target (post author, profile), or nobody. */
export function blockableFor(
  target: SafetyTarget,
): { readonly humanId: HumanId; readonly displayName: string } | null {
  switch (target.kind) {
    case 'post':
      return { humanId: target.authorHumanId, displayName: target.authorDisplayName }
    case 'profile':
      return { humanId: target.humanId, displayName: target.displayName }
    case 'room':
    case 'guest':
      return null
    default: {
      const exhaustive: never = target
      throw new Error(`Unknown safety target: ${String(exhaustive)}`)
    }
  }
}

/**
 * Whether the person may take an action: Humans always; a Guest may report the room they are in
 * or a fellow Guest (DB_API §7); everyone else claims first (spec §43).
 */
export function safetyActionAllowed(
  roleKind: string,
  key: SafetyActionKey,
  targetKind: SafetyTarget['kind'],
): boolean {
  if (roleKind === 'human') return true
  return (
    roleKind === 'guest' && key === 'report' && (targetKind === 'room' || targetKind === 'guest')
  )
}

// ---------------------------------------------------------------------------
// Settings → Safety lists
// ---------------------------------------------------------------------------

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

export function blockedName(block: BlockedHuman): string {
  return block.identity?.displayName ?? copy.human
}

/** The list after an unblock answered. */
export function withoutBlocked(blocks: readonly BlockedHuman[], humanId: string): BlockedHuman[] {
  return blocks.filter((block) => block.blockedHumanId !== humanId)
}
