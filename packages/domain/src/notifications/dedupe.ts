/**
 * Live notification dedupe (spec §87; ARCHITECTURE §11) and notification priorities (spec §40,
 * SCREEN 23). The database (`earth.notify_live` with `notification_cooldowns`) is authoritative;
 * this is the pure mirror the DB tests and the server share.
 *
 * Rules per recipient × room:
 * 1. First eligible event → send (initial high-relevance Live notification).
 * 2. Within the cooldown window, exactly one extra send is allowed, and only when a direct friend
 *    of the recipient who has not been mentioned yet joins on camera (materially changes relevance).
 * 3. Everything else inside the window is participant churn → no send.
 * 4. Viewers (`watching`) never trigger anything: they are not visible participants.
 * 5. Once the cooldown has elapsed, the next eligible event opens a new window.
 */
import { LIVE_NOTIFICATION_COOLDOWN_MINUTES } from '../constants'
import type { MediaState, NotificationPriority, NotificationType } from '../enums'
import { EarthError } from '../errors'

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

export type NotifyTimeInput = string | number | Date

/** Sends allowed inside one cooldown window: the initial one plus one friend-joined extra. */
export const LIVE_SENDS_PER_WINDOW = 2

export interface LiveJoiningParticipant {
  readonly humanId: string
  readonly isDirectFriendOfRecipient: boolean
  readonly mediaState: MediaState
}

export interface ShouldNotifyLiveInput {
  /** `notification_cooldowns.last_sent_at`; `null` when this room never notified the recipient. */
  readonly lastSentAt: NotifyTimeInput | null
  /** `notification_cooldowns.notified_participant_ids`: Humans already mentioned to the recipient. */
  readonly notifiedParticipantIds: readonly string[]
  /**
   * Sends already made in the current window (1 after the initial, 2 after the extra). Defaults
   * to 1 when `lastSentAt` is set, 0 otherwise — pass the stored counter when available.
   */
  readonly sendsInWindow?: number
  /** The Human whose join triggered the evaluation; `null` for room-level events (start, open up). */
  readonly joiningParticipant: LiveJoiningParticipant | null
  readonly now: NotifyTimeInput
  readonly cooldownMinutes?: number
}

export const LIVE_NOTIFY_REASONS = [
  'initial',
  'cooldown_elapsed',
  'friend_joined_on_camera',
  'viewer_join',
  'cooldown',
  'not_direct_friend',
  'not_on_camera',
  'already_notified',
  'extra_send_used',
] as const
export type LiveNotifyReason = (typeof LIVE_NOTIFY_REASONS)[number]

/** The cooldown row after a send, for the caller to persist. */
export interface LiveCooldownState {
  readonly lastSentAt: string
  readonly notifiedParticipantIds: readonly string[]
  readonly sendsInWindow: number
}

export type LiveNotifyDecision =
  | { readonly send: true; readonly reason: LiveNotifyReason; readonly next: LiveCooldownState }
  | { readonly send: false; readonly reason: LiveNotifyReason }

function toMs(value: NotifyTimeInput): number {
  return value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : Date.parse(value)
}

/** Milliseconds for a time input, or `EarthError('invalid_input')` when it is not a real instant. */
function requireMs(value: NotifyTimeInput, field: 'now' | 'lastSentAt'): number {
  const ms = toMs(value)
  if (!Number.isFinite(ms)) {
    throw new EarthError('invalid_input', {
      details: { field, reason: 'invalid_date' },
      message: `${field}: invalid date`,
    })
  }
  return ms
}

function toIso(ms: number): string {
  return new Date(ms).toISOString()
}

function withParticipant(
  ids: readonly string[],
  participant: LiveJoiningParticipant | null,
): string[] {
  if (participant === null || ids.includes(participant.humanId)) return [...ids]
  return [...ids, participant.humanId]
}

export function shouldNotifyLive(input: ShouldNotifyLiveInput): LiveNotifyDecision {
  const cooldownMinutes = input.cooldownMinutes ?? LIVE_NOTIFICATION_COOLDOWN_MINUTES
  const joining = input.joiningParticipant
  const nowMs = requireMs(input.now, 'now')
  const lastSentMs = input.lastSentAt === null ? null : requireMs(input.lastSentAt, 'lastSentAt')

  // Rule 4: viewers are invisible; nothing to announce.
  if (joining !== null && joining.mediaState === 'watching') {
    return { send: false, reason: 'viewer_join' }
  }

  const windowOpen = lastSentMs !== null && nowMs - lastSentMs < cooldownMinutes * 60_000

  // Rules 1 and 5: no window → send and open one.
  if (!windowOpen) {
    return {
      send: true,
      reason: lastSentMs === null ? 'initial' : 'cooldown_elapsed',
      next: {
        lastSentAt: toIso(nowMs),
        notifiedParticipantIds: withParticipant(input.notifiedParticipantIds, joining),
        sendsInWindow: 1,
      },
    }
  }

  // Rule 3: room-level churn inside the window.
  if (joining === null) return { send: false, reason: 'cooldown' }
  if (!joining.isDirectFriendOfRecipient) return { send: false, reason: 'not_direct_friend' }
  if (joining.mediaState !== 'camera') return { send: false, reason: 'not_on_camera' }
  if (input.notifiedParticipantIds.includes(joining.humanId)) {
    return { send: false, reason: 'already_notified' }
  }
  const sendsInWindow = input.sendsInWindow ?? 1
  if (sendsInWindow >= LIVE_SENDS_PER_WINDOW) return { send: false, reason: 'extra_send_used' }

  // Rule 2: the one extra send. `last_sent_at` moves to now — the cooldown is always measured from
  // the most recent send, so the extra never shortens the quiet period — and the counter records
  // that the extra is spent until the window elapses.
  return {
    send: true,
    reason: 'friend_joined_on_camera',
    next: {
      lastSentAt: toIso(nowMs),
      notifiedParticipantIds: withParticipant(input.notifiedParticipantIds, joining),
      sendsInWindow: sendsInWindow + 1,
    },
  }
}

// ---------------------------------------------------------------------------
// Priority (spec §40 `notification_priority`; SCREEN 23 "Priority ranking")
// ---------------------------------------------------------------------------

export const NOTIFICATION_PRIORITY_BY_TYPE: Readonly<
  Record<NotificationType, NotificationPriority>
> = {
  friend_live: 'critical_social',
  multi_live: 'critical_social',
  group_live: 'critical_social',
  direct_message: 'high',
  friend_request: 'high',
  friend_accepted: 'high',
  group_invitation: 'high',
  group_message: 'normal',
  follow: 'low',
}

export function priorityFor(type: NotificationType): NotificationPriority {
  return NOTIFICATION_PRIORITY_BY_TYPE[type]
}

/** Sort rank for `notifications_list` ordering (lower first); likes would rank below `low`. */
export const NOTIFICATION_PRIORITY_RANK: Readonly<Record<NotificationPriority, number>> = {
  critical_social: 0,
  high: 1,
  normal: 2,
  low: 3,
}

export function priorityRank(priority: NotificationPriority): number {
  return NOTIFICATION_PRIORITY_RANK[priority]
}
