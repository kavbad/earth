/**
 * Expo push adapter (spec §12): `createExpoPushSender(expo)` turns an injected `expo-server-sdk`
 * client (structurally typed, so tests pass a fake) into the `PushSender` of `ServerDeps`. Messages
 * are chunked as Expo requires; a chunk whose request fails yields transient error tickets so the
 * dispatcher leaves those notifications for the next run; tokens that are not Expo push tokens are
 * refused locally with `DeviceNotRegistered`.
 */
import type { PushMessage, PushReceipt, PushSender, PushTicket } from '../deps'

/** The subset of `Expo` (expo-server-sdk) the sender uses. */
export interface ExpoClientLike {
  chunkPushNotifications(messages: ExpoPushMessageLike[]): ExpoPushMessageLike[][]
  sendPushNotificationsAsync(messages: ExpoPushMessageLike[]): Promise<ExpoPushTicketLike[]>
  getPushNotificationReceiptsAsync?(ids: string[]): Promise<Record<string, ExpoPushReceiptLike>>
  chunkPushNotificationReceiptIds?(ids: string[]): string[][]
}

export interface ExpoPushMessageLike {
  to: string | string[]
  title?: string
  body?: string
  data?: Record<string, unknown>
  priority?: 'default' | 'normal' | 'high'
  sound?: string | null
  channelId?: string
}

export type ExpoPushTicketLike =
  | { status: 'ok'; id: string }
  | { status: 'error'; message: string; details?: { error?: string; expoPushToken?: string } }

export type ExpoPushReceiptLike =
  { status: 'ok' } | { status: 'error'; message: string; details?: { error?: string } }

export interface ExpoPushSenderOptions {
  /** Defaults to Expo's own rule (`ExponentPushToken[...]` / `ExpoPushToken[...]` / legacy uuid). */
  readonly isExpoPushToken?: (token: string) => boolean
}

const LEGACY_TOKEN_REGEX = /^[a-z\d]{8}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{12}$/i

/** Mirrors `Expo.isExpoPushToken`. */
export function isExpoPushToken(token: string): boolean {
  return (
    ((token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken[')) &&
      token.endsWith(']')) ||
    LEGACY_TOKEN_REGEX.test(token)
  )
}

export const INVALID_TOKEN_MESSAGE = 'not an Expo push token' as const
export const CHUNK_FAILED_MESSAGE = 'push chunk request failed' as const

function toExpoMessage(message: PushMessage): ExpoPushMessageLike {
  const out: ExpoPushMessageLike = {
    to: message.to,
    title: message.title,
    body: message.body,
    data: { ...message.data },
    priority: message.priority,
  }
  if (message.sound !== undefined) out.sound = message.sound
  if (message.channelId !== undefined) out.channelId = message.channelId
  return out
}

function fromExpoTicket(ticket: ExpoPushTicketLike | undefined): PushTicket {
  if (ticket === undefined) {
    return { status: 'error', message: 'no ticket returned', transient: true }
  }
  if (ticket.status === 'ok') return { status: 'ok', id: ticket.id }
  return ticket.details === undefined
    ? { status: 'error', message: ticket.message }
    : { status: 'error', message: ticket.message, details: ticket.details }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function createExpoPushSender(
  expo: ExpoClientLike,
  options: ExpoPushSenderOptions = {},
): PushSender {
  const isValidToken = options.isExpoPushToken ?? isExpoPushToken
  return {
    async send(messages) {
      const tickets: PushTicket[] = new Array<PushTicket>(messages.length)
      const sendable: { index: number; message: ExpoPushMessageLike }[] = []
      messages.forEach((message, index) => {
        if (!isValidToken(message.to)) {
          tickets[index] = {
            status: 'error',
            message: INVALID_TOKEN_MESSAGE,
            details: { error: 'DeviceNotRegistered', expoPushToken: message.to },
          }
          return
        }
        sendable.push({ index, message: toExpoMessage(message) })
      })
      // Expo's chunker keeps message order, so each chunk maps back to a contiguous slice.
      const chunks = expo.chunkPushNotifications(sendable.map((s) => s.message))
      let offset = 0
      for (const chunk of chunks) {
        const slots = sendable.slice(offset, offset + chunk.length)
        offset += chunk.length
        try {
          const chunkTickets = await expo.sendPushNotificationsAsync(chunk)
          slots.forEach((slot, i) => {
            tickets[slot.index] = fromExpoTicket(chunkTickets[i])
          })
        } catch (cause) {
          for (const slot of slots) {
            tickets[slot.index] = {
              status: 'error',
              message: `${CHUNK_FAILED_MESSAGE}: ${errorMessage(cause)}`,
              transient: true,
            }
          }
        }
      }
      return tickets.map((ticket) =>
        ticket === undefined
          ? { status: 'error', message: 'message was not sent', transient: true }
          : ticket,
      )
    },
    async receipts(ids) {
      const fetchReceipts = expo.getPushNotificationReceiptsAsync
      if (fetchReceipts === undefined || ids.length === 0) return {}
      const chunker = expo.chunkPushNotificationReceiptIds
      const chunks = chunker === undefined ? [[...ids]] : chunker.call(expo, [...ids])
      const out: Record<string, PushReceipt> = {}
      for (const chunk of chunks) {
        const receipts = await fetchReceipts.call(expo, chunk)
        for (const [id, receipt] of Object.entries(receipts)) {
          out[id] =
            receipt.status === 'ok'
              ? { status: 'ok' }
              : { status: 'error', message: receipt.message, details: receipt.details }
        }
      }
      return out
    },
  }
}
