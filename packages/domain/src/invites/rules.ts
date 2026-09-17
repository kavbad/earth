/**
 * Invite usability (spec §24, §35, §112; DB_API §2/§3). The database validates on use; these
 * helpers let previews (`/g/:token`, `/live/:token`) explain why a link no longer works and let
 * the server pick the matching error code.
 */
import {
  DEEP_LINK_PATHS,
  groupInviteUrl,
  parseDeepLink,
  roomInviteUrl,
  type DeepLink,
} from '../constants'
import type { GroupInviteStatus, RoomStatus } from '../enums'
import type { EarthErrorCode } from '../errors'

// ---------------------------------------------------------------------------
// Usability
// ---------------------------------------------------------------------------

export const INVITE_UNUSABLE_REASONS = ['expired', 'exhausted', 'revoked', 'ended'] as const
export type InviteUnusableReason = (typeof INVITE_UNUSABLE_REASONS)[number]

export type InviteUsability =
  { readonly usable: true } | { readonly usable: false; readonly reason: InviteUnusableReason }

export type InviteTimeInput = string | number | Date

function toMs(value: InviteTimeInput): number {
  return value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : Date.parse(value)
}

/** True when `at` is at or before `now`; an unparsable `at` counts as passed (fail closed). */
function hasPassed(at: InviteTimeInput | null, now: InviteTimeInput): boolean {
  if (at === null) return false
  const atMs = toMs(at)
  const nowMs = toMs(now)
  if (!Number.isFinite(atMs) || !Number.isFinite(nowMs)) return true
  return atMs <= nowMs
}

export interface GroupInviteUsabilityInput {
  readonly status: GroupInviteStatus
  /** `null` never expires (spec §24 `expires_at nullable`). */
  readonly expiresAt: InviteTimeInput | null
  /** `null` is unlimited (spec §24 `max_uses nullable`). */
  readonly maxUses: number | null
  readonly useCount: number
  readonly now: InviteTimeInput
}

/** Revoked beats expired beats exhausted, so the preview shows the most definitive reason. */
export function isGroupInviteUsable(input: GroupInviteUsabilityInput): InviteUsability {
  if (input.status === 'revoked') return { usable: false, reason: 'revoked' }
  if (input.status === 'expired' || hasPassed(input.expiresAt, input.now)) {
    return { usable: false, reason: 'expired' }
  }
  if (input.status === 'exhausted' || (input.maxUses !== null && input.useCount >= input.maxUses)) {
    return { usable: false, reason: 'exhausted' }
  }
  return { usable: true }
}

/** Uses left on a group invite; `null` when unlimited. */
export function remainingUses(maxUses: number | null, useCount: number): number | null {
  return maxUses === null ? null : Math.max(0, maxUses - useCount)
}

export interface RoomInviteUsabilityInput {
  /** Room invites always expire (spec §35 `expires_at`). */
  readonly expiresAt: InviteTimeInput
  readonly revokedAt: InviteTimeInput | null
  /** The room's status; an ended room makes its links unusable (`room_ended`). */
  readonly roomStatus: RoomStatus
  readonly now: InviteTimeInput
}

export function isRoomInviteUsable(input: RoomInviteUsabilityInput): InviteUsability {
  if (input.revokedAt !== null) return { usable: false, reason: 'revoked' }
  if (input.roomStatus === 'ended') return { usable: false, reason: 'ended' }
  if (hasPassed(input.expiresAt, input.now)) return { usable: false, reason: 'expired' }
  return { usable: true }
}

/** The error code the RPC raises for an unusable invite (`invite_*`, `room_ended`). */
export function inviteErrorCodeFor(reason: InviteUnusableReason): EarthErrorCode {
  switch (reason) {
    case 'expired':
      return 'invite_expired'
    case 'exhausted':
      return 'invite_exhausted'
    case 'revoked':
      return 'invite_invalid'
    case 'ended':
      return 'room_ended'
  }
}

// ---------------------------------------------------------------------------
// URLs (spec §112) — thin wrappers over ../constants so the paths have one home
// ---------------------------------------------------------------------------

export const INVITE_KINDS = ['group', 'room'] as const
export type InviteKind = (typeof INVITE_KINDS)[number]

export type InviteLink =
  | { readonly kind: 'group'; readonly token: string }
  | { readonly kind: 'room'; readonly token: string }

/** `https://earth.social/g/:token` or `https://earth.social/live/:token`. */
export function inviteUrl(kind: InviteKind, origin: string, token: string): string {
  return kind === 'group' ? groupInviteUrl(origin, token) : roomInviteUrl(origin, token)
}

/** The path prefix of an invite kind (`/g/`, `/live/`). */
export function invitePathPrefix(kind: InviteKind): string {
  return kind === 'group' ? DEEP_LINK_PATHS.groupInvite : DEEP_LINK_PATHS.roomInvite
}

/** Parses a URL / path / app link into an invite, or `null` when it is not an invite link. */
export function parseInviteLink(input: string): InviteLink | null {
  const link: DeepLink | null = parseDeepLink(input)
  if (link === null) return null
  switch (link.kind) {
    case 'group_invite':
      return { kind: 'group', token: link.token }
    case 'room_invite':
      return { kind: 'room', token: link.token }
    case 'profile':
    case 'post':
      return null
  }
}
