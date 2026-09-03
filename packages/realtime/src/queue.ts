/**
 * Offline outbox for messages (spec §53 realtime delivery, §54 "handle offline messages without
 * duplicate sends", §107 "chat messages can queue", §108 "visible retry indicator; tap to retry;
 * idempotent resend").
 *
 * Every send is keyed by the client-generated `clientId`; `message_send` is idempotent on it
 * (DB_API §2), so a retry — automatic or manual — reuses the same id and can never duplicate a
 * message. Items persist through the injected storage so a killed app resumes its queue. Flushes
 * are sequential (chat order), a single flush runs at a time, and an item is marked `failed`
 * after `maxAttempts` (3) or immediately on a non-retryable server error; `retry()` puts it back.
 * An `enqueue` or `retry` that lands while a flush is winding down (its pass already past the
 * item, or paused by a connectivity blink) waits for it and runs one more pass for that item.
 */
import {
  type ConversationId,
  type EarthErrorCode,
  type HumanId,
  type MessageDto,
  type MessageSendInput,
  MessageSendInputSchema,
  asMessageId,
  isEarthError,
} from '@earth/domain'

import { type RealtimeClock, errorReason, systemClock } from './clock'
import { type RealtimeDiagnostics, emitDiagnostic, noopDiagnostics } from './diagnostics'

export const OUTBOX_MAX_ATTEMPTS = 3

export const OUTBOX_ITEM_STATUSES = ['pending', 'sending', 'failed'] as const
export type OutboxItemStatus = (typeof OUTBOX_ITEM_STATUSES)[number]

/** Delivery state of an optimistic message as rendered by the chat UI (spec §53 step 2/7). */
export const OPTIMISTIC_MESSAGE_STATUSES = ['pending', 'failed', 'sent'] as const
export type OptimisticMessageStatus = (typeof OPTIMISTIC_MESSAGE_STATUSES)[number]

/** Server error codes worth retrying; anything else (`blocked`, `not_a_member`, ...) fails at once. */
export const OUTBOX_RETRYABLE_CODES: ReadonlySet<EarthErrorCode> = new Set<EarthErrorCode>([
  'rate_limited',
  'internal',
])

export interface OutboxItem {
  readonly clientId: string
  readonly conversationId: ConversationId
  readonly input: MessageSendInput
  readonly attempts: number
  readonly lastError: string | null
  readonly status: OutboxItemStatus
  /** ISO 8601 enqueue time; also the optimistic `createdAt` (spec §54). */
  readonly createdAt: string
}

/** A `MessageDto` the UI can render before the server acknowledges it; `id` is the `clientId`. */
export interface OptimisticMessage extends MessageDto {
  readonly status: OptimisticMessageStatus
}

export interface OutboxStorage {
  /** Previously persisted items (any shape is tolerated; malformed entries are dropped). */
  get(): Promise<unknown> | unknown
  set(items: readonly OutboxItem[]): Promise<void> | void
}

export interface OutboxState {
  readonly items: readonly OutboxItem[]
  readonly flushing: boolean
}

export interface FlushResult {
  readonly sent: number
  readonly failed: number
  /** Items left pending (offline, transient failure or a flush already in progress). */
  readonly deferred: number
}

export interface CreateOutboxOptions {
  readonly storage: OutboxStorage
  /** `message_send(...)` through `@earth/api`; must reuse `item.input.clientId`. */
  readonly send: (item: OutboxItem) => Promise<MessageDto>
  readonly isOnline: () => boolean
  /** The viewer; the optimistic message's `senderHumanId`. */
  readonly senderHumanId: HumanId
  readonly clock?: RealtimeClock
  readonly maxAttempts?: number
  readonly diagnostics?: RealtimeDiagnostics
  /** The server's DTO for an item that was just sent; replace the optimistic message with it. */
  readonly onSent?: (message: MessageDto, item: OutboxItem) => void
  /** `enqueue` starts a flush when online. Defaults to `true`. */
  readonly autoFlush?: boolean
}

export interface Outbox {
  /** Hydrates from storage; called lazily by every other method. */
  load(): Promise<void>
  /** Persists the item and returns the optimistic message to render (`status: 'pending'`). */
  enqueue(input: MessageSendInput): Promise<OptimisticMessage>
  /** Sends pending items in order; a flush already in progress is awaited instead of duplicated. */
  flush(): Promise<FlushResult>
  /** "Tap to retry" (spec §108): back to pending with the same `clientId`, then flush. */
  retry(clientId: string): Promise<FlushResult>
  /** Drops an item (the user discarded a failed message). */
  remove(clientId: string): Promise<void>
  state(): OutboxState
  optimisticMessage(item: OutboxItem): OptimisticMessage
  subscribe(listener: (state: OutboxState) => void): () => void
}

const STATUS_SET: ReadonlySet<string> = new Set<string>(OUTBOX_ITEM_STATUSES)

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Validates persisted items; `sending` (interrupted mid-flush) resumes as `pending`. */
export function parseOutboxItems(value: unknown): OutboxItem[] {
  if (!Array.isArray(value)) return []
  const items: OutboxItem[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    const record = asRecord(raw)
    if (record === null) continue
    const input = MessageSendInputSchema.safeParse(record['input'])
    if (!input.success) continue
    const clientId = record['clientId']
    if (typeof clientId !== 'string' || clientId !== input.data.clientId || seen.has(clientId)) {
      continue
    }
    const attempts = record['attempts']
    const lastError = record['lastError']
    const status = record['status']
    const createdAt = record['createdAt']
    if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 0) continue
    if (lastError !== null && typeof lastError !== 'string') continue
    if (typeof status !== 'string' || !STATUS_SET.has(status)) continue
    if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) continue
    seen.add(clientId)
    items.push({
      clientId,
      conversationId: input.data.conversationId,
      input: input.data,
      attempts,
      lastError,
      status: status === 'sending' ? 'pending' : (status as OutboxItemStatus),
      createdAt,
    })
  }
  return items
}

function isRetryableSendError(error: unknown): boolean {
  return isEarthError(error) ? OUTBOX_RETRYABLE_CODES.has(error.code) : true
}

export function createOutbox(options: CreateOutboxOptions): Outbox {
  const clock = options.clock ?? systemClock
  const diagnostics = options.diagnostics ?? noopDiagnostics
  const maxAttempts = options.maxAttempts ?? OUTBOX_MAX_ATTEMPTS
  const autoFlush = options.autoFlush ?? true

  let items: OutboxItem[] = []
  let loaded: Promise<void> | null = null
  let flushing: Promise<FlushResult> | null = null
  const listeners = new Set<(state: OutboxState) => void>()

  const state = (): OutboxState => ({ items, flushing: flushing !== null })

  const notify = (): void => {
    const snapshot = state()
    for (const listener of listeners) listener(snapshot)
  }

  const persist = async (): Promise<void> => {
    try {
      await options.storage.set(items)
    } catch {
      // Storage is a convenience; the in-memory queue still drives delivery.
    }
    notify()
  }

  const load = (): Promise<void> => {
    if (loaded === null) {
      loaded = (async () => {
        try {
          const persisted = parseOutboxItems(await options.storage.get())
          // Items enqueued before the load finished stay ahead of nothing: persisted ones are older.
          items = [
            ...persisted,
            ...items.filter((i) => !persisted.some((p) => p.clientId === i.clientId)),
          ]
        } catch {
          // Unreadable storage behaves like an empty outbox.
        }
        notify()
      })()
    }
    return loaded
  }

  const replace = (clientId: string, patch: Partial<OutboxItem>): OutboxItem | null => {
    const index = items.findIndex((item) => item.clientId === clientId)
    const existing = items[index]
    if (existing === undefined) return null
    const next = { ...existing, ...patch }
    items = [...items.slice(0, index), next, ...items.slice(index + 1)]
    return next
  }

  const optimisticMessage = (item: OutboxItem): OptimisticMessage => ({
    id: asMessageId(item.clientId),
    conversationId: item.conversationId,
    senderHumanId: options.senderHumanId,
    type: item.input.type,
    text: item.input.text,
    payload: item.input.payload,
    replyToMessageId: item.input.replyToMessageId,
    createdAt: item.createdAt,
    editedAt: null,
    deletedAt: null,
    clientId: item.clientId,
    reactions: [],
    status: item.status === 'failed' ? 'failed' : 'pending',
  })

  const sendOne = async (item: OutboxItem): Promise<'sent' | 'failed' | 'deferred'> => {
    replace(item.clientId, { status: 'sending' })
    notify()
    try {
      const message = await options.send(item)
      items = items.filter((i) => i.clientId !== item.clientId)
      await persist()
      options.onSent?.(message, item)
      return 'sent'
    } catch (error) {
      const attempts = item.attempts + 1
      const exhausted = attempts >= maxAttempts || !isRetryableSendError(error)
      const lastError = errorReason(error)
      replace(item.clientId, {
        attempts,
        lastError,
        status: exhausted ? 'failed' : 'pending',
      })
      await persist()
      if (exhausted) {
        emitDiagnostic(diagnostics, {
          kind: 'message_send_failed',
          conversationId: item.conversationId,
          attempt: attempts,
          reason: lastError,
          ...(isEarthError(error) ? { code: error.code } : {}),
        })
        return 'failed'
      }
      return 'deferred'
    }
  }

  const runFlush = async (): Promise<FlushResult> => {
    await load()
    let sent = 0
    let failed = 0
    // Pending items in order; a transient failure stops this pass so order is preserved.
    while (options.isOnline()) {
      const next = items.find((item) => item.status === 'pending')
      if (next === undefined) break
      const outcome = await sendOne(next)
      if (outcome === 'sent') sent += 1
      else if (outcome === 'failed') failed += 1
      else break
    }
    const deferred = items.filter((item) => item.status === 'pending').length
    return { sent, failed, deferred }
  }

  const flush = (): Promise<FlushResult> => {
    if (flushing !== null) return flushing
    flushing = runFlush().finally(() => {
      flushing = null
      notify()
    })
    notify()
    return flushing
  }

  /**
   * Flushes so that `item` gets its attempt: a pass already running re-reads the queue, but it may
   * have stepped past the item (or stopped on an offline check) before the item became pending.
   * Items are immutable snapshots, so "untouched" is an identity check.
   */
  const ensureFlushed = async (item: OutboxItem): Promise<FlushResult> => {
    const inFlight = flushing
    if (inFlight === null) return flush()
    const result = await inFlight
    const current = items.find((i) => i.clientId === item.clientId)
    if (current === item && current.status === 'pending' && options.isOnline()) return flush()
    return result
  }

  return {
    load,
    optimisticMessage,
    async enqueue(input) {
      await load()
      const existing = items.find((item) => item.clientId === input.clientId)
      if (existing !== undefined) return optimisticMessage(existing)
      const item: OutboxItem = {
        clientId: input.clientId,
        conversationId: input.conversationId,
        input,
        attempts: 0,
        lastError: null,
        status: 'pending',
        createdAt: new Date(clock.now()).toISOString(),
      }
      items = [...items, item]
      await persist()
      if (autoFlush && options.isOnline()) void ensureFlushed(item)
      return optimisticMessage(item)
    },
    flush,
    async retry(clientId) {
      await load()
      let item = items.find((i) => i.clientId === clientId)
      if (item === undefined) return { sent: 0, failed: 0, deferred: 0 }
      if (item.status === 'failed') {
        item = replace(clientId, { status: 'pending', attempts: 0, lastError: null }) ?? item
        await persist()
      }
      return ensureFlushed(item)
    },
    async remove(clientId) {
      await load()
      if (!items.some((item) => item.clientId === clientId)) return
      items = items.filter((item) => item.clientId !== clientId)
      await persist()
    },
    state,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
