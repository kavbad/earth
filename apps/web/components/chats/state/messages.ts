/**
 * The message store of one open conversation (spec §53–§54): server pages, realtime inserts and
 * updates, optimistic sends from the outbox, reaction changes — reduced into one ascending list.
 *
 * Ordering: the server timestamp is canonical. Acknowledged messages sort by `(createdAt, id)`;
 * messages still in the outbox (`pending` / `failed`) sort after every acknowledged one in the
 * order they were written, so a slow clock can never push a fresh optimistic message into the
 * middle of the thread. Deduplication is by server id and, for the sender's own messages, by
 * `clientId`: the realtime insert or the outbox acknowledgement — whichever lands first — replaces
 * the optimistic row and the other is a no-op.
 *
 * Pure so it is unit-tested without React.
 */
import type { HumanId, MessageDto, MessageId, MessageReactionSummaryDto } from '@earth/domain'
import type {
  MessageChange,
  OptimisticMessage,
  OptimisticMessageStatus,
  ReactionChangeEvent,
} from '@earth/realtime'

export interface ChatMessage extends MessageDto {
  readonly status: OptimisticMessageStatus
}

export interface MessagesState {
  /** Ascending: oldest first. */
  readonly messages: readonly ChatMessage[]
  /** `messages_list` cursor for the page before the oldest loaded message; `null` = nothing older. */
  readonly nextCursor: string | null
  /** The first page has arrived. */
  readonly loaded: boolean
}

export const INITIAL_MESSAGES_STATE: MessagesState = {
  messages: [],
  nextCursor: null,
  loaded: false,
}

export type MessagesAction =
  /** A `messages_list` page (newest first on the wire). `initial` resets the store. */
  | {
      readonly type: 'page'
      readonly messages: readonly MessageDto[]
      readonly nextCursor: string | null
      readonly initial: boolean
    }
  /** A realtime insert/update, or a polling catch-up row. */
  | { readonly type: 'received'; readonly message: MessageDto; readonly change: MessageChange }
  /** The outbox's view of every queued item, as optimistic messages. */
  | { readonly type: 'outbox'; readonly messages: readonly OptimisticMessage[] }
  /** The server's DTO for an outbox item that was just acknowledged. */
  | { readonly type: 'sent'; readonly clientId: string; readonly message: MessageDto }
  /** A `message_reactions` row appeared or disappeared. */
  | {
      readonly type: 'reaction'
      readonly event: ReactionChangeEvent
      readonly viewerHumanId: HumanId | null
    }
  /** The viewer toggled a reaction; applied before the server confirms. */
  | { readonly type: 'toggleReaction'; readonly messageId: MessageId; readonly reaction: string }
  /** The viewer deleted a message; tombstoned before the server confirms. */
  | { readonly type: 'deleted'; readonly messageId: MessageId; readonly at: string }
  /** A failed optimistic message was discarded. */
  | { readonly type: 'discard'; readonly clientId: string }

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

function statusRank(status: OptimisticMessageStatus): number {
  return status === 'sent' ? 0 : 1
}

function timeMs(value: string): number {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
}

/** `(status rank, createdAt, id)` ascending — see the module comment. */
export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  const rank = statusRank(a.status) - statusRank(b.status)
  if (rank !== 0) return rank
  const timeA = timeMs(a.createdAt)
  const timeB = timeMs(b.createdAt)
  if (timeA !== timeB) return timeA < timeB ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function insertSorted(list: readonly ChatMessage[], message: ChatMessage): ChatMessage[] {
  let low = 0
  let high = list.length
  while (low < high) {
    const mid = (low + high) >>> 1
    const candidate = list[mid]
    if (candidate !== undefined && compareMessages(candidate, message) < 0) low = mid + 1
    else high = mid
  }
  return [...list.slice(0, low), message, ...list.slice(low)]
}

function withoutId(list: readonly ChatMessage[], id: string): ChatMessage[] {
  return list.filter((message) => message.id !== id)
}

function findById(list: readonly ChatMessage[], id: string): ChatMessage | undefined {
  return list.find((message) => message.id === id)
}

/** The optimistic row (id = clientId) an acknowledged server message replaces, if any. */
function findOptimisticFor(
  list: readonly ChatMessage[],
  message: MessageDto,
): ChatMessage | undefined {
  if (message.clientId === null) return undefined
  const clientId = message.clientId
  return list.find(
    (candidate) =>
      candidate.status !== 'sent' &&
      candidate.id === clientId &&
      candidate.senderHumanId === message.senderHumanId,
  )
}

function asSent(message: MessageDto): ChatMessage {
  return { ...message, status: 'sent' }
}

/**
 * Upserts an acknowledged server message: replaces an existing row with the same id (keeping the
 * held reactions when the update carries none — realtime updates never do) and removes the
 * optimistic row it acknowledges.
 */
function upsertServerMessage(
  list: readonly ChatMessage[],
  message: MessageDto,
  change: MessageChange,
): ChatMessage[] {
  const optimistic = findOptimisticFor(list, message)
  let next = optimistic === undefined ? list : withoutId(list, optimistic.id)
  const existing = findById(next, message.id)
  if (existing !== undefined) {
    const reactions =
      change === 'updated' && message.reactions.length === 0
        ? existing.reactions
        : message.reactions
    next = withoutId(next, message.id)
    return insertSorted(next, { ...asSent(message), reactions })
  }
  if (change === 'updated' && optimistic === undefined) {
    // An update for a message we never loaded (older than the first page): nothing to show.
    return [...list]
  }
  return insertSorted(next, asSent(message))
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

function adjustReaction(
  reactions: readonly MessageReactionSummaryDto[],
  reaction: string,
  delta: 1 | -1,
  byViewer: boolean,
): MessageReactionSummaryDto[] {
  const existing = reactions.find((summary) => summary.reaction === reaction)
  if (existing === undefined) {
    if (delta < 0) return [...reactions]
    return [...reactions, { reaction, count: 1, reactedByMe: byViewer }]
  }
  // Idempotent for the viewer: an optimistic toggle followed by its own realtime echo is one change.
  if (byViewer && delta > 0 && existing.reactedByMe) return [...reactions]
  if (byViewer && delta < 0 && !existing.reactedByMe) return [...reactions]
  const count = Math.max(0, existing.count + delta)
  const reactedByMe = byViewer ? delta > 0 : existing.reactedByMe
  const next = { reaction, count, reactedByMe }
  return reactions
    .map((summary) => (summary.reaction === reaction ? next : summary))
    .filter((summary) => summary.count > 0)
}

function mapMessage(
  list: readonly ChatMessage[],
  id: string,
  update: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
  return list.map((message) => (message.id === id ? update(message) : message))
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function messagesReducer(state: MessagesState, action: MessagesAction): MessagesState {
  switch (action.type) {
    case 'page': {
      let list: ChatMessage[] = action.initial
        ? state.messages.filter((message) => message.status !== 'sent')
        : [...state.messages]
      for (const message of action.messages) list = upsertServerMessage(list, message, 'inserted')
      return {
        messages: list,
        nextCursor: action.initial || state.loaded ? action.nextCursor : state.nextCursor,
        loaded: true,
      }
    }
    case 'received':
      return {
        ...state,
        messages: upsertServerMessage(state.messages, action.message, action.change),
      }
    case 'outbox': {
      let list = [...state.messages]
      const queued = new Set(action.messages.map((message) => message.clientId ?? message.id))
      // Rows the outbox no longer holds and the server never acknowledged were discarded elsewhere.
      list = list.filter((message) => message.status === 'sent' || queued.has(message.id))
      for (const message of action.messages) {
        const existing = findById(list, message.id)
        if (existing !== undefined) {
          if (existing.status === message.status) continue
          list = insertSorted(withoutId(list, message.id), { ...existing, status: message.status })
          continue
        }
        // Already acknowledged (realtime insert won the race): the outbox row is stale.
        const acknowledged = list.some(
          (candidate) => candidate.status === 'sent' && candidate.clientId === message.clientId,
        )
        if (acknowledged) continue
        list = insertSorted(list, message)
      }
      return { ...state, messages: list }
    }
    case 'sent': {
      const list = withoutId(state.messages, action.clientId)
      return { ...state, messages: upsertServerMessage(list, action.message, 'inserted') }
    }
    case 'reaction': {
      const { event, viewerHumanId } = action
      const byViewer = viewerHumanId !== null && event.humanId === viewerHumanId
      return {
        ...state,
        messages: mapMessage(state.messages, event.messageId, (message) => ({
          ...message,
          reactions: adjustReaction(
            message.reactions,
            event.reaction,
            event.change === 'added' ? 1 : -1,
            byViewer,
          ),
        })),
      }
    }
    case 'toggleReaction':
      return {
        ...state,
        messages: mapMessage(state.messages, action.messageId, (message) => {
          const mine = message.reactions.find((summary) => summary.reaction === action.reaction)
          const delta = mine?.reactedByMe === true ? -1 : 1
          return {
            ...message,
            reactions: adjustReaction(message.reactions, action.reaction, delta, true),
          }
        }),
      }
    case 'deleted':
      return {
        ...state,
        messages: mapMessage(state.messages, action.messageId, (message) => ({
          ...message,
          text: null,
          payload: {},
          deletedAt: message.deletedAt ?? action.at,
        })),
      }
    case 'discard':
      return { ...state, messages: withoutId(state.messages, action.clientId) }
    default: {
      const exhaustive: never = action
      throw new Error(`Unknown messages action: ${String(exhaustive)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Newest acknowledged message (what `conversation_mark_read` and catch-ups key on). */
export function newestSentMessage(messages: readonly ChatMessage[]): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message !== undefined && message.status === 'sent') return message
  }
  return null
}

export function newestSentMessageId(messages: readonly ChatMessage[]): MessageId | null {
  return newestSentMessage(messages)?.id ?? null
}

/** Oldest acknowledged message id — the `beforeId` of the next older page. */
export function oldestSentMessageId(messages: readonly ChatMessage[]): MessageId | null {
  const oldest = messages.find((message) => message.status === 'sent')
  return oldest?.id ?? null
}

/** The viewer's reaction summaries that are not poll votes (`poll:<id>`), for the emoji row. */
export function isViewerReaction(summary: MessageReactionSummaryDto): boolean {
  return summary.reactedByMe
}

// ---------------------------------------------------------------------------
// Grouping (spec §94: faces, messages, legibility — one sender's run reads as one block)
// ---------------------------------------------------------------------------

/** Consecutive messages of one sender within this window form one group. */
export const GROUP_WINDOW_MS = 5 * 60_000
/** A group never grows past this many messages, so a virtual row stays small. */
export const GROUP_MAX_MESSAGES = 20

export type GroupPosition = 'single' | 'first' | 'middle' | 'last'

export interface MessageRow {
  readonly message: ChatMessage
  readonly isMine: boolean
  readonly position: GroupPosition
  /** Day separator rendered above this row (`Today`, `Yesterday`, `Tue`, `Mar 4`). */
  readonly dayLabel: string | null
  /** Whether the row shows the time (last of a group) — never on system rows. */
  readonly showTime: boolean
}

const DAY_MS = 24 * 60 * 60_000
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const

export interface DayLabelCopy {
  readonly today: string
  readonly yesterday: string
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** `Today` · `Yesterday` · `Tue` (within six days) · `Mar 4` · `Mar 4, 2025` (other year). */
export function dayLabel(
  iso: string,
  now: Date,
  copy: DayLabelCopy = { today: 'Today', yesterday: 'Yesterday' },
): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ''
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS)
  if (days <= 0) return copy.today
  if (days === 1) return copy.yesterday
  if (days < 7) return WEEKDAYS[date.getDay()] ?? ''
  const monthDay = `${MONTHS[date.getMonth()] ?? ''} ${date.getDate()}`
  return date.getFullYear() === now.getFullYear() ? monthDay : `${monthDay}, ${date.getFullYear()}`
}

function sameDay(a: string, b: string): boolean {
  const dateA = new Date(a)
  const dateB = new Date(b)
  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  )
}

function canGroup(previous: ChatMessage, next: ChatMessage): boolean {
  if (previous.type === 'system' || next.type === 'system') return false
  if (previous.senderHumanId !== next.senderHumanId) return false
  if (!sameDay(previous.createdAt, next.createdAt)) return false
  const gap = timeMs(next.createdAt) - timeMs(previous.createdAt)
  return Number.isFinite(gap) && gap >= 0 && gap <= GROUP_WINDOW_MS
}

/** Annotates the ascending list with grouping, day separators and ownership. */
export function annotateMessages(
  messages: readonly ChatMessage[],
  viewerHumanId: HumanId | null,
  now: Date = new Date(),
  copy?: DayLabelCopy,
): MessageRow[] {
  const rows: MessageRow[] = []
  let groupSize = 0
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message === undefined) continue
    const previous = messages[index - 1]
    const next = messages[index + 1]
    const continuesPrevious =
      previous !== undefined && canGroup(previous, message) && groupSize < GROUP_MAX_MESSAGES
    groupSize = continuesPrevious ? groupSize + 1 : 1
    const continuesNext =
      next !== undefined && canGroup(message, next) && groupSize < GROUP_MAX_MESSAGES
    const position: GroupPosition = continuesPrevious
      ? continuesNext
        ? 'middle'
        : 'last'
      : continuesNext
        ? 'first'
        : 'single'
    const showDay = previous === undefined || !sameDay(previous.createdAt, message.createdAt)
    rows.push({
      message,
      isMine: viewerHumanId !== null && message.senderHumanId === viewerHumanId,
      position,
      dayLabel: showDay ? dayLabel(message.createdAt, now, copy) : null,
      showTime: message.type !== 'system' && (position === 'last' || position === 'single'),
    })
  }
  return rows
}

/** `3:42 PM` in the device locale; empty for an invalid date. */
export function timeLabel(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
