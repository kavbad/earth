/**
 * Notification copy (spec §86, exact strings) from structured inputs. `@earth/ui` may delegate
 * its builders here; `notifications_list` payloads carry the names (DB_API §6) and are turned into
 * a typed input by `notificationCopyFromPayload`.
 */
import { z } from 'zod'

import type { NotificationType } from '../enums'
import { formatNameList, groupLiveTitle, LIVE_JOIN_PROMPT, liveTitle } from '../rooms/naming'

export interface NotificationCopy {
  readonly title: string
  /** May be empty (social notifications have no body). */
  readonly body: string
}

/** One variant per `NotificationType`. Shapes match `@earth/ui`'s `NotificationCopyInput`. */
export type NotificationCopyInput =
  | { readonly type: 'direct_message'; readonly senderName: string; readonly preview: string }
  | {
      readonly type: 'group_message'
      readonly groupName: string
      readonly senderName: string
      readonly preview: string
    }
  | { readonly type: 'friend_live'; readonly name: string; readonly activity?: string | null }
  | { readonly type: 'multi_live'; readonly names: readonly string[]; readonly total?: number }
  | {
      readonly type: 'group_live'
      readonly groupName: string
      readonly names: readonly string[]
      readonly total?: number
    }
  | { readonly type: 'friend_request'; readonly name: string }
  | { readonly type: 'friend_accepted'; readonly name: string }
  | { readonly type: 'follow'; readonly name: string }
  | { readonly type: 'group_invitation'; readonly name: string; readonly groupName: string }

// Compile-time proof that every NotificationType has exactly one input variant.
type _CoversEveryType = NotificationType extends NotificationCopyInput['type']
  ? NotificationCopyInput['type'] extends NotificationType
    ? true
    : never
  : never
const _coversEveryType: _CoversEveryType = true
void _coversEveryType

function activityOrPrompt(activity: string | null | undefined): string {
  const trimmed = activity?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : LIVE_JOIN_PROMPT
}

/** Spec §86, verbatim. */
export function notificationCopy(input: NotificationCopyInput): NotificationCopy {
  switch (input.type) {
    case 'direct_message':
      // "Xavier" + message preview
      return { title: input.senderName, body: input.preview }
    case 'group_message':
      // "Weekend Crew" + "Maya: message preview"
      return { title: input.groupName, body: `${input.senderName}: ${input.preview}` }
    case 'friend_live':
      // "Xavier is live" + "Cooking dinner"
      return { title: liveTitle([input.name], 1), body: activityOrPrompt(input.activity) }
    case 'multi_live':
      // "Xavier + Maya are live" + "Join them"
      return {
        title: liveTitle(input.names, Math.max(input.total ?? input.names.length, 2)),
        body: LIVE_JOIN_PROMPT,
      }
    case 'group_live':
      // "Weekend Crew is live" + "Xavier, Maya + 2"
      return {
        title: groupLiveTitle(input.groupName),
        body: formatNameList(input.names, input.total),
      }
    case 'friend_request':
      // "Maya wants to be friends"
      return { title: `${input.name} wants to be friends`, body: '' }
    case 'friend_accepted':
      // "You and Maya are friends"
      return { title: `You and ${input.name} are friends`, body: '' }
    case 'follow':
      // "Sam followed you"
      return { title: `${input.name} followed you`, body: '' }
    case 'group_invitation':
      // "Xavier brought you into Weekend Crew"
      return { title: `${input.name} brought you into ${input.groupName}`, body: '' }
  }
}

// ---------------------------------------------------------------------------
// Payload → input (what `earth.notify` stores in `notifications.payload`)
// ---------------------------------------------------------------------------

const Name = z.string().trim().min(1)
const Names = z
  .array(z.string())
  .transform((names) => names.map((n) => n.trim()).filter((n) => n.length > 0))
const Total = z.int().min(0).optional()

/** Keys `earth.notify` writes into `payload`, per type. */
export const NOTIFICATION_PAYLOAD_SCHEMAS = {
  direct_message: z.object({ senderName: Name, preview: z.string().default('') }),
  group_message: z.object({ groupName: Name, senderName: Name, preview: z.string().default('') }),
  friend_live: z.object({ name: Name, activity: z.string().nullish() }),
  multi_live: z.object({ names: Names.pipe(z.array(z.string()).min(1)), total: Total }),
  group_live: z.object({ groupName: Name, names: Names, total: Total }),
  friend_request: z.object({ name: Name }),
  friend_accepted: z.object({ name: Name }),
  follow: z.object({ name: Name }),
  group_invitation: z.object({ name: Name, groupName: Name }),
} as const satisfies Record<NotificationType, z.ZodType>

function withOptional<T extends object>(base: T, key: string, value: unknown): T {
  return value === undefined ? base : { ...base, [key]: value }
}

/**
 * Builds the typed input from a stored payload. Returns `null` when the payload lacks the names
 * the copy needs (the caller should then fall back to a generic row, never crash a list).
 */
export function notificationCopyInputFromPayload(
  type: NotificationType,
  payload: unknown,
): NotificationCopyInput | null {
  switch (type) {
    case 'direct_message': {
      const r = NOTIFICATION_PAYLOAD_SCHEMAS.direct_message.safeParse(payload)
      return r.success ? { type, senderName: r.data.senderName, preview: r.data.preview } : null
    }
    case 'group_message': {
      const r = NOTIFICATION_PAYLOAD_SCHEMAS.group_message.safeParse(payload)
      return r.success
        ? {
            type,
            groupName: r.data.groupName,
            senderName: r.data.senderName,
            preview: r.data.preview,
          }
        : null
    }
    case 'friend_live': {
      const r = NOTIFICATION_PAYLOAD_SCHEMAS.friend_live.safeParse(payload)
      return r.success ? { type, name: r.data.name, activity: r.data.activity ?? null } : null
    }
    case 'multi_live': {
      const r = NOTIFICATION_PAYLOAD_SCHEMAS.multi_live.safeParse(payload)
      return r.success ? withOptional({ type, names: r.data.names }, 'total', r.data.total) : null
    }
    case 'group_live': {
      const r = NOTIFICATION_PAYLOAD_SCHEMAS.group_live.safeParse(payload)
      return r.success
        ? withOptional(
            { type, groupName: r.data.groupName, names: r.data.names },
            'total',
            r.data.total,
          )
        : null
    }
    case 'friend_request':
    case 'friend_accepted':
    case 'follow': {
      const r = NOTIFICATION_PAYLOAD_SCHEMAS[type].safeParse(payload)
      return r.success ? { type, name: r.data.name } : null
    }
    case 'group_invitation': {
      const r = NOTIFICATION_PAYLOAD_SCHEMAS.group_invitation.safeParse(payload)
      return r.success ? { type, name: r.data.name, groupName: r.data.groupName } : null
    }
  }
}

/** Copy for a stored notification row, or `null` when its payload is unusable. */
export function notificationCopyFromPayload(
  type: NotificationType,
  payload: unknown,
): NotificationCopy | null {
  const input = notificationCopyInputFromPayload(type, payload)
  return input === null ? null : notificationCopy(input)
}
