/**
 * Bridges from the vendor SDKs to the structural types the server tier is written against:
 *
 * - `supabaseClientFrom`: a `SupabaseClient` as `SupabaseRpcClient` + the `identity_reviews`
 *   table chain (`./verification.ts`), built by delegation so the compiler never compares the
 *   SDK's deep generic client type with ours.
 * - `expoClientFrom`: `expo-server-sdk`'s `Expo` as `ExpoClientLike` of `@earth/server`.
 * - `sentrySdkFrom`: the `@sentry/nextjs` namespace as `SentrySdkLike` (`./monitor.ts`).
 *   `@earth/observability`'s `SentryLike` admits `undefined` members in its scope, user and
 *   breadcrumb shapes; Sentry's types (under `exactOptionalPropertyTypes`) do not, so members
 *   that are `undefined` are dropped before the call — the SDK receives only what was set.
 *
 * Only `deps.ts` hands real SDK instances in; tests use fakes shaped like the SDK surfaces.
 */
import type {
  ExpoClientLike,
  ExpoPushMessageLike,
  ExpoPushReceiptLike,
  ExpoPushTicketLike,
  SupabaseRpcClient,
} from '@earth/server'
import type {
  SentryBreadcrumb,
  SentryLike,
  SentryScopeContext,
  SentrySeverityLevel,
  SentryUser,
} from '@earth/observability'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Expo, ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from 'expo-server-sdk'

import type { SentryInitOptions, SentrySdkLike } from './monitor'
import type { IdentityReviewInsert, SupabaseTableClientLike } from './verification'
import type { WebSupabaseClient } from './wiring'

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

export function supabaseClientFrom(client: SupabaseClient): WebSupabaseClient {
  const rpc: SupabaseRpcClient = { rpc: (name, args) => client.rpc(name, args) }
  const tables: SupabaseTableClientLike = {
    from: (table) => ({
      insert: (row: IdentityReviewInsert) => ({
        select: (columns) => ({
          single: () => client.from(table).insert(row).select(columns).single(),
        }),
      }),
      select: (columns) => ({
        eq: (column, value) => ({
          maybeSingle: () => client.from(table).select(columns).eq(column, value).maybeSingle(),
        }),
      }),
    }),
  }
  return { ...rpc, ...tables }
}

// ---------------------------------------------------------------------------
// Expo
// ---------------------------------------------------------------------------

/** The four `Expo` methods the push sender uses, with the SDK's own types. */
export type ExpoSdkLike = Pick<
  Expo,
  | 'chunkPushNotifications'
  | 'sendPushNotificationsAsync'
  | 'getPushNotificationReceiptsAsync'
  | 'chunkPushNotificationReceiptIds'
>

function toExpoTicketLike(ticket: ExpoPushTicket): ExpoPushTicketLike {
  if (ticket.status === 'ok') return { status: 'ok', id: ticket.id }
  return ticket.details === undefined
    ? { status: 'error', message: ticket.message }
    : { status: 'error', message: ticket.message, details: ticket.details }
}

function toExpoReceiptLike(receipt: ExpoPushReceipt): ExpoPushReceiptLike {
  if (receipt.status === 'ok') return { status: 'ok' }
  return receipt.details === undefined
    ? { status: 'error', message: receipt.message }
    : { status: 'error', message: receipt.message, details: receipt.details }
}

export function expoClientFrom(expo: ExpoSdkLike): ExpoClientLike {
  return {
    chunkPushNotifications(messages: ExpoPushMessageLike[]): ExpoPushMessageLike[][] {
      // The chunker regroups the very objects it was given (`ExpoPushMessageLike` is a subset of
      // `ExpoPushMessage`), so each chunk still holds `ExpoPushMessageLike` values.
      const chunks: ExpoPushMessage[][] = expo.chunkPushNotifications(messages)
      return chunks as ExpoPushMessageLike[][]
    },
    async sendPushNotificationsAsync(messages: ExpoPushMessageLike[]): Promise<ExpoPushTicketLike[]> {
      const tickets = await expo.sendPushNotificationsAsync(messages)
      return tickets.map(toExpoTicketLike)
    },
    async getPushNotificationReceiptsAsync(ids: string[]): Promise<Record<string, ExpoPushReceiptLike>> {
      const receipts = await expo.getPushNotificationReceiptsAsync(ids)
      const out: Record<string, ExpoPushReceiptLike> = {}
      for (const [id, receipt] of Object.entries(receipts)) out[id] = toExpoReceiptLike(receipt)
      return out
    },
    chunkPushNotificationReceiptIds(ids: string[]): string[][] {
      return expo.chunkPushNotificationReceiptIds(ids)
    },
  }
}

// ---------------------------------------------------------------------------
// Sentry
// ---------------------------------------------------------------------------

/** `T` with every member optional and never explicitly `undefined` (what Sentry's types accept). */
export type WithoutUndefined<T> = { [K in keyof T]?: Exclude<T[K], undefined> }

export type SentryScopeContextStrict = WithoutUndefined<SentryScopeContext>
export type SentryUserStrict = WithoutUndefined<SentryUser>
export type SentryBreadcrumbStrict = WithoutUndefined<SentryBreadcrumb>

/** The `@sentry/nextjs` namespace as this module calls it (its real signatures are wider). */
export interface SentryNamespaceLike {
  init(options: SentryInitOptions): unknown
  captureException(exception: unknown, captureContext?: SentryScopeContextStrict): unknown
  captureMessage(
    message: string,
    captureContext?: SentryScopeContextStrict | SentrySeverityLevel,
  ): unknown
  setUser(user: SentryUserStrict | null): unknown
  addBreadcrumb(breadcrumb: SentryBreadcrumbStrict): unknown
  setTag(key: string, value: string): unknown
  flush(timeout?: number): Promise<boolean>
}

/** Drops `undefined` members (same keys otherwise — exactly what the mapped type says). */
export function withoutUndefined<T extends object>(value: T): WithoutUndefined<T> {
  const out: Record<string, unknown> = {}
  for (const [key, member] of Object.entries(value)) {
    if (member !== undefined) out[key] = member
  }
  return out as WithoutUndefined<T>
}

export function sentrySdkFrom(sentry: SentryNamespaceLike): SentrySdkLike {
  const monitorSurface: SentryLike = {
    captureException: (exception, captureContext) =>
      captureContext === undefined
        ? sentry.captureException(exception)
        : sentry.captureException(exception, withoutUndefined(captureContext)),
    captureMessage: (message, captureContext) =>
      captureContext === undefined
        ? sentry.captureMessage(message)
        : sentry.captureMessage(
            message,
            typeof captureContext === 'string' ? captureContext : withoutUndefined(captureContext),
          ),
    setUser: (user) => sentry.setUser(user === null ? null : withoutUndefined(user)),
    addBreadcrumb: (breadcrumb) => sentry.addBreadcrumb(withoutUndefined(breadcrumb)),
    setTag: (key, value) => sentry.setTag(key, value),
    flush: (timeout) => sentry.flush(timeout),
  }
  return { ...monitorSurface, init: (options) => sentry.init(options) }
}
