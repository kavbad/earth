/**
 * Server-tier dependencies (ARCHITECTURE §6). Every handler is a pure function of
 * `(deps, request)` so the same code runs in Next route handlers today and in an Edge Function or
 * a standalone service later. Nothing here touches `process.env` or a vendor SDK directly:
 * clients are described structurally and injected (`createServerDepsFromEnv` in `./index.ts`
 * wires the real ones; tests pass fakes).
 */
import type { AnalyticsSink } from '@earth/analytics'
import type { ServerEnv } from '@earth/config'
import type { Logger } from '@earth/observability'

import type { HumanVerificationProvider } from './verification/provider-types'

// ---------------------------------------------------------------------------
// Supabase (structural)
// ---------------------------------------------------------------------------

/** The PostgREST error shape (`PostgrestError` satisfies it). */
export interface RpcError {
  readonly message: string
  readonly code?: string | null | undefined
  readonly details?: string | null | undefined
  readonly hint?: string | null | undefined
}

export interface RpcResult {
  readonly data: unknown
  readonly error: RpcError | null
}

/** RPC arguments as PostgREST sends them (snake_case keys). */
export type RpcArgs = Readonly<Record<string, unknown>>

/**
 * The slice of `SupabaseClient` the server tier uses. `supabase-js`'s `rpc()` returns a thenable
 * builder resolving to `{ data, error }`, which satisfies this structurally.
 */
export interface SupabaseRpcClient {
  rpc(name: string, args?: RpcArgs): PromiseLike<RpcResult>
}

/**
 * `auth.admin` of the service-role supabase-js client, structurally: only what the account
 * deletion route uses (`POST /api/account/delete` → `human_delete_request`, then the credential).
 */
export interface AuthAdminLike {
  deleteUser(userId: string): PromiseLike<{ readonly error: { readonly message: string } | null }>
}

/** A client that carries `auth.admin` (the real service-role client does; the RPC-only fakes do not). */
export interface AuthAdminHostLike {
  readonly auth?: { readonly admin?: AuthAdminLike | undefined } | undefined
}

// ---------------------------------------------------------------------------
// LiveKit
// ---------------------------------------------------------------------------

/** The webhook event fields the server reads (`WebhookEvent` of livekit-server-sdk satisfies it). */
export interface LiveKitWebhookEventLike {
  readonly event: string
  readonly id?: string | undefined
  /** Unix seconds (protobuf int64: `bigint` in the SDK). */
  readonly createdAt?: bigint | number | undefined
  readonly room?:
    { readonly name?: string | undefined; readonly sid?: string | undefined } | undefined
  readonly participant?:
    { readonly identity?: string | undefined; readonly sid?: string | undefined } | undefined
}

/** `WebhookReceiver` of livekit-server-sdk, structurally: verifies the signature and parses the body. */
export interface LiveKitWebhookReceiverLike {
  receive(body: string, authHeader?: string): Promise<LiveKitWebhookEventLike>
}

export interface LiveKitConfig {
  readonly apiKey: string
  readonly apiSecret: string
  /** Websocket URL handed to clients with their token (`LIVEKIT_URL`). */
  readonly url: string
  /** Overrides the SDK receiver built from `apiKey` / `apiSecret` (tests, alternative verifiers). */
  readonly webhookReceiver?: LiveKitWebhookReceiverLike | undefined
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

export const PUSH_PRIORITIES = ['default', 'normal', 'high'] as const
export type PushPriority = (typeof PUSH_PRIORITIES)[number]

/** One push message to one device token (mirrors `ExpoPushMessage`'s subset the dispatcher uses). */
export interface PushMessage {
  readonly to: string
  readonly title: string
  readonly body: string
  readonly data: Readonly<Record<string, unknown>>
  readonly priority: PushPriority
  readonly sound?: 'default' | null | undefined
  readonly channelId?: string | undefined
}

/** Error names Expo reports on tickets and receipts. */
export const PUSH_ERROR_KINDS = [
  'DeviceNotRegistered',
  'DeveloperError',
  'ExpoError',
  'InvalidCredentials',
  'MessageRateExceeded',
  'MessageTooBig',
  'ProviderError',
] as const
export type PushErrorKind = (typeof PUSH_ERROR_KINDS)[number]

export interface PushOkTicket {
  readonly status: 'ok'
  /** Receipt id, when the provider issues one. */
  readonly id?: string | undefined
}

export interface PushErrorTicket {
  readonly status: 'error'
  readonly message: string
  readonly details?:
    | {
        readonly error?: PushErrorKind | string | undefined
        readonly expoPushToken?: string | undefined
      }
    | undefined
  /** `true` when the failure was the transport (network, 5xx) and a retry may succeed. */
  readonly transient?: boolean | undefined
}

/** One ticket per message, in message order. */
export type PushTicket = PushOkTicket | PushErrorTicket

export interface PushReceipt {
  readonly status: 'ok' | 'error'
  readonly message?: string | undefined
  readonly details?: { readonly error?: PushErrorKind | string | undefined } | undefined
}

export interface PushSender {
  /** Sends every message (chunking as the provider requires) and returns one ticket per message. */
  send(messages: readonly PushMessage[]): Promise<readonly PushTicket[]>
  /** Delivery receipts for earlier tickets, keyed by receipt id. Optional. */
  receipts?(ids: readonly string[]): Promise<Readonly<Record<string, PushReceipt>>>
}

// ---------------------------------------------------------------------------
// ServerDeps
// ---------------------------------------------------------------------------

export interface ServerDeps {
  /** Service role; runs `service` RPCs. Never shipped to clients. */
  readonly supabaseAdmin: SupabaseRpcClient
  /** Anon key without a session: runs RPCs as a Visitor (`GET /api/feed?scope=world`, ingest). */
  readonly supabaseAnon: SupabaseRpcClient
  /** Anon key + `Authorization: Bearer <accessToken>`: runs RPCs as the caller. */
  supabaseForUser(accessToken: string): SupabaseRpcClient
  readonly livekit: LiveKitConfig
  readonly verification: HumanVerificationProvider
  readonly push: PushSender
  readonly analytics: AnalyticsSink
  readonly logger: Logger
  now(): Date
  readonly env: ServerEnv
  /** `INTERNAL_CRON_SECRET`; compared in constant time against `x-earth-cron-secret`. */
  readonly cronSecret: string
  /**
   * The Supabase admin auth API (service role) for `POST /api/account/delete`. Optional: without
   * it the Human is still deleted and the response says `credentialDeleted: false`.
   */
  readonly authAdmin?: AuthAdminLike | undefined
}

export type { AnalyticsSink, Logger, ServerEnv, HumanVerificationProvider }
