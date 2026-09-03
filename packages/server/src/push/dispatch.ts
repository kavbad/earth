/**
 * Push dispatcher — `POST /api/internal/push/dispatch` (ARCHITECTURE §6, §11; spec §12).
 *
 * Notification rows are the source of truth (created by SQL); push is an output channel.
 * Each run: `notifications_unsent(limit)` → group by recipient → skip recipients who are looking
 * at the very conversation (presence within `PRESENCE_ACTIVE_WINDOW_SECONDS` and
 * `active_conversation_id` equal) → build Expo messages with the spec §86 copy → send through
 * `deps.push` → `notifications_mark_pushed(ids)`.
 *
 * Marking: a notification is marked pushed once it has been handled — delivered to at least one
 * device, suppressed, without tokens, or refused by the provider on every device for a
 * non-transient reason (`DeviceNotRegistered` and friends are logged; the contract has no service
 * RPC to drop tokens, so nothing else is done). A notification that reached no device and hit a
 * transport failure on any of them (a transient ticket, a sender that threw, a missing ticket) is
 * left unsent for the next run — never marked on the strength of a refusal elsewhere.
 */
import { PRESENCE_ACTIVE_WINDOW_SECONDS } from '@earth/domain'
import { z } from 'zod'

import { requireCronSecret } from '../cron'
import type { PushMessage, PushTicket, ServerDeps } from '../deps'
import {
  AnyRpcResultSchema,
  type EarthRequest,
  type EarthResponse,
  ok,
  parseInput,
  readJson,
  requestQuery,
  rpcAdmin,
} from '../http'
import {
  UnsentNotificationsResultSchema,
  type UnsentNotificationRow,
  conversationIdOf,
  pushMessagesFor,
} from './messages'

export const NOTIFICATIONS_UNSENT_RPC = 'notifications_unsent' as const
export const NOTIFICATIONS_MARK_PUSHED_RPC = 'notifications_mark_pushed' as const
export const PUSH_DISPATCH_DEFAULT_LIMIT = 500
export const PUSH_DISPATCH_MAX_LIMIT = 2000

export const PUSH_LOG = {
  run: 'push.dispatch',
  ticketError: 'push.ticket_error',
  copyMissing: 'push.copy_missing',
  sendFailed: 'push.send_failed',
} as const

/** Ticket message when the sender itself threw: every planned message is deferred. */
export const SEND_FAILED_MESSAGE = 'push sender failed' as const
/** Ticket message when the sender answered fewer tickets than messages. */
export const NO_TICKET_MESSAGE = 'no ticket' as const

export const PushDispatchInputSchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(PUSH_DISPATCH_MAX_LIMIT)
    .default(PUSH_DISPATCH_DEFAULT_LIMIT),
})

export interface PushDispatchCounts {
  readonly fetched: number
  readonly recipients: number
  /** Messages accepted by the provider. */
  readonly sent: number
  /** Notifications skipped because the recipient was active in that conversation. */
  readonly suppressed: number
  /** Notifications with no device token or unusable copy. */
  readonly skipped: number
  /** Messages refused by the provider (non-transient). */
  readonly failed: number
  /** Messages that hit a transport failure; their notifications stay unsent. */
  readonly deferred: number
  /** Notifications marked `push_sent_at`. */
  readonly marked: number
}

export interface PushDispatchOutcome extends PushDispatchCounts {
  readonly ok: true
  readonly ranAt: string
}

/** ARCHITECTURE §11: active within 30 s and looking at the notification's conversation. */
export function isRecipientActiveInConversation(row: UnsentNotificationRow, now: Date): boolean {
  const presence = row.presence
  if (presence === null || presence.lastActiveAt === null) return false
  const conversationId = conversationIdOf(row)
  if (conversationId === undefined || presence.activeConversationId !== conversationId) return false
  const ageMs = now.getTime() - Date.parse(presence.lastActiveAt)
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= PRESENCE_ACTIVE_WINDOW_SECONDS * 1000
}

/** Rows with a repeated `id` (a duplicated join row) count once: one push, one mark. */
export function dedupeRows(rows: readonly UnsentNotificationRow[]): UnsentNotificationRow[] {
  const seen = new Set<string>()
  const unique: UnsentNotificationRow[] = []
  for (const row of rows) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    unique.push(row)
  }
  return unique
}

export function groupByRecipient(
  rows: readonly UnsentNotificationRow[],
): Map<string, UnsentNotificationRow[]> {
  const groups = new Map<string, UnsentNotificationRow[]>()
  for (const row of dedupeRows(rows)) {
    const list = groups.get(row.recipientHumanId)
    if (list === undefined) groups.set(row.recipientHumanId, [row])
    else list.push(row)
  }
  return groups
}

interface PlannedMessage {
  readonly notificationId: string
  readonly message: PushMessage
}

export interface DispatchPlan {
  readonly messages: readonly PlannedMessage[]
  /** Notifications handled without sending (suppressed / no tokens / no copy). */
  readonly handledWithoutSend: readonly string[]
  readonly suppressed: number
  readonly skipped: number
  readonly recipients: number
}

/** Pure planning step: which messages to send and which notifications need no push. */
export function planDispatch(
  rows: readonly UnsentNotificationRow[],
  now: Date,
  onCopyMissing: (row: UnsentNotificationRow) => void = () => undefined,
): DispatchPlan {
  const groups = groupByRecipient(rows)
  const messages: PlannedMessage[] = []
  const handledWithoutSend: string[] = []
  let suppressed = 0
  let skipped = 0
  for (const recipientRows of groups.values()) {
    for (const row of recipientRows) {
      if (isRecipientActiveInConversation(row, now)) {
        suppressed += 1
        handledWithoutSend.push(row.id)
        continue
      }
      if (row.pushTokens.length === 0) {
        skipped += 1
        handledWithoutSend.push(row.id)
        continue
      }
      const built = pushMessagesFor(row)
      if (built === null) {
        onCopyMissing(row)
        skipped += 1
        handledWithoutSend.push(row.id)
        continue
      }
      for (const message of built) messages.push({ notificationId: row.id, message })
    }
  }
  return { messages, handledWithoutSend, suppressed, skipped, recipients: groups.size }
}

export interface TicketTally {
  sent: number
  failed: number
  deferred: number
  /**
   * Notification ids that are done: delivered to at least one device, or refused on every
   * device for a non-transient reason. These get `push_sent_at`.
   */
  settled: Set<string>
  /**
   * Notification ids that reached no device and hit at least one transport failure. They stay
   * unsent for the next run. Disjoint from `settled`.
   */
  deferredIds: Set<string>
}

/**
 * Per-message tickets folded into per-notification outcomes. A missing ticket is a transport
 * failure (the provider did not answer for that message), never a success.
 */
export function tallyTickets(
  planned: readonly PlannedMessage[],
  tickets: readonly PushTicket[],
  onTicketError: (planned: PlannedMessage, ticket: PushTicket) => void = () => undefined,
): TicketTally {
  const tally: TicketTally = {
    sent: 0,
    failed: 0,
    deferred: 0,
    settled: new Set(),
    deferredIds: new Set(),
  }
  const delivered = new Set<string>()
  const transient = new Set<string>()
  /** Notification ids in first-seen order (deterministic marking order for the logs/tests). */
  const order = new Set<string>()
  planned.forEach((item, index) => {
    const id = item.notificationId
    order.add(id)
    const ticket: PushTicket = tickets[index] ?? {
      status: 'error',
      message: NO_TICKET_MESSAGE,
      transient: true,
    }
    if (ticket.status === 'ok') {
      tally.sent += 1
      delivered.add(id)
      return
    }
    onTicketError(item, ticket)
    if (ticket.transient === true) {
      tally.deferred += 1
      transient.add(id)
    } else {
      tally.failed += 1
    }
  })
  for (const id of order) {
    if (delivered.has(id) || !transient.has(id)) tally.settled.add(id)
    else tally.deferredIds.add(id)
  }
  return tally
}

/** Sends the planned messages; a sender that throws yields transient tickets for every message. */
export async function sendPlanned(
  deps: ServerDeps,
  planned: readonly PlannedMessage[],
): Promise<readonly PushTicket[]> {
  if (planned.length === 0) return []
  try {
    return await deps.push.send(planned.map((m) => m.message))
  } catch (cause) {
    deps.logger.error(PUSH_LOG.sendFailed, { error: cause, messages: planned.length })
    return planned.map(() => ({ status: 'error', message: SEND_FAILED_MESSAGE, transient: true }))
  }
}

async function readLimit(req: EarthRequest): Promise<number> {
  const fromQuery = requestQuery(req).get('limit')
  const body = await readJson(req).catch(() => undefined)
  const raw: Record<string, unknown> = {}
  const bodyLimit =
    typeof body === 'object' && body !== null ? (body as { limit?: unknown }).limit : undefined
  if (bodyLimit !== undefined) raw['limit'] = bodyLimit
  else if (fromQuery !== null) raw['limit'] = fromQuery
  return parseInput(PushDispatchInputSchema, raw, 'limit').limit
}

/** `POST /api/internal/push/dispatch` (cron). */
export async function handlePushDispatch(
  deps: ServerDeps,
  req: EarthRequest,
): Promise<EarthResponse> {
  requireCronSecret(deps, req)
  const limit = await readLimit(req)
  const now = deps.now()
  const rows = await rpcAdmin(
    deps,
    NOTIFICATIONS_UNSENT_RPC,
    { limit },
    UnsentNotificationsResultSchema,
  )

  const plan = planDispatch(rows, now, (row) =>
    deps.logger.warn(PUSH_LOG.copyMissing, { notificationId: row.id, type: row.type }),
  )
  const tickets = await sendPlanned(deps, plan.messages)
  const tally = tallyTickets(plan.messages, tickets, (item, ticket) =>
    deps.logger.warn(PUSH_LOG.ticketError, {
      notificationId: item.notificationId,
      error: ticket.status === 'error' ? ticket.details?.error : undefined,
      message: ticket.status === 'error' ? ticket.message : undefined,
      transient: ticket.status === 'error' && ticket.transient === true,
    }),
  )

  // Handled without a send (suppressed / no token / no copy) or settled by the provider. A
  // deferred id is never in either set; the delete is a belt-and-braces guard.
  const toMark = new Set<string>([...plan.handledWithoutSend, ...tally.settled])
  for (const id of tally.deferredIds) toMark.delete(id)
  if (toMark.size > 0) {
    await rpcAdmin(deps, NOTIFICATIONS_MARK_PUSHED_RPC, { ids: [...toMark] }, AnyRpcResultSchema)
  }

  const counts: PushDispatchCounts = {
    fetched: rows.length,
    recipients: plan.recipients,
    sent: tally.sent,
    suppressed: plan.suppressed,
    skipped: plan.skipped,
    failed: tally.failed,
    deferred: tally.deferred,
    marked: toMark.size,
  }
  deps.logger.info(PUSH_LOG.run, { ...counts })
  const body: PushDispatchOutcome = { ok: true, ranAt: now.toISOString(), ...counts }
  return ok(body)
}
