/**
 * LiveKit webhook (ARCHITECTURE §6): verifies the signature with the SDK's `WebhookReceiver`
 * (JWT in `Authorization`, signed with the API secret, carrying the body's sha256) and reconciles
 * `room_participants` through the service RPC `room_participant_sync` (DB_API §3). Earth owns the
 * room model; LiveKit events are hints that are reconciled, never the source of truth (spec §9).
 *
 * After a successful verification the route always answers 200: LiveKit retries non-2xx responses
 * and a replayed event adds nothing (`room_participant_sync` ignores out-of-order events and
 * `rooms_sweep` reconciles what a lost event would have done).
 */
import { EarthError, isUuid, parseMediaIdentity } from '@earth/domain'
import { WebhookReceiver } from 'livekit-server-sdk'

import type { LiveKitWebhookEventLike, LiveKitWebhookReceiverLike, ServerDeps } from '../deps'
import {
  AUTHORIZATION_HEADER,
  AnyRpcResultSchema,
  type EarthRequest,
  type EarthResponse,
  HTTP_STATUS,
  error,
  ok,
  rpcAdmin,
} from '../http'

export const ROOM_PARTICIPANT_SYNC_RPC = 'room_participant_sync' as const

/** LiveKit event names the sync RPC understands (DB_API §3). */
export const LIVEKIT_SYNC_EVENTS = [
  'participant_joined',
  'participant_left',
  'room_finished',
] as const
export type LiveKitSyncEvent = (typeof LIVEKIT_SYNC_EVENTS)[number]
const SYNC_EVENT_SET: ReadonlySet<string> = new Set<string>(LIVEKIT_SYNC_EVENTS)

export function isLiveKitSyncEvent(value: string): value is LiveKitSyncEvent {
  return SYNC_EVENT_SET.has(value)
}

export const WEBHOOK_LOG = {
  rejected: 'livekit.webhook_rejected',
  ignored: 'livekit.webhook_ignored',
  outOfOrder: 'rtc.webhook_out_of_order',
  syncFailed: 'livekit.webhook_sync_failed',
} as const

export interface LiveKitWebhookOutcome {
  readonly ok: boolean
  readonly event: string
  readonly handled: boolean
  readonly reason?: string
}

export function webhookReceiverFor(deps: ServerDeps): LiveKitWebhookReceiverLike {
  return (
    deps.livekit.webhookReceiver ?? new WebhookReceiver(deps.livekit.apiKey, deps.livekit.apiSecret)
  )
}

/** The event's `createdAt` (unix seconds) as ISO 8601, or `fallback` when LiveKit omitted it. */
export function webhookEventAt(event: LiveKitWebhookEventLike, fallback: Date): string {
  const raw = event.createdAt
  const seconds = typeof raw === 'bigint' ? Number(raw) : typeof raw === 'number' ? raw : 0
  if (!Number.isFinite(seconds) || seconds <= 0) return fallback.toISOString()
  return new Date(seconds * 1000).toISOString()
}

function outcome(event: string, handled: boolean, okFlag: boolean, reason?: string): EarthResponse {
  const body: LiveKitWebhookOutcome =
    reason === undefined ? { ok: okFlag, event, handled } : { ok: okFlag, event, handled, reason }
  return ok(body)
}

function isOutOfOrder(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false
  const record = result as { ignored?: unknown; outOfOrder?: unknown; reason?: unknown }
  return record.ignored === true || record.outOfOrder === true || record.reason === 'out_of_order'
}

/** `POST /api/livekit/webhook`. */
export async function handleLiveKitWebhook(
  deps: ServerDeps,
  req: EarthRequest,
): Promise<EarthResponse> {
  const body = await req.text()
  const authHeader = req.headers.get(AUTHORIZATION_HEADER) ?? undefined
  let event: LiveKitWebhookEventLike
  try {
    event = await webhookReceiverFor(deps).receive(body, authHeader)
  } catch (cause) {
    deps.logger.warn(WEBHOOK_LOG.rejected, { error: cause })
    return error(HTTP_STATUS.unauthorized, 'not_authenticated', { reason: 'invalid_signature' })
  }

  const name = event.event
  if (!isLiveKitSyncEvent(name)) return outcome(name, false, true, 'unhandled_event')

  const roomId = event.room?.name
  if (roomId === undefined || !isUuid(roomId)) {
    deps.logger.warn(WEBHOOK_LOG.ignored, { event: name, reason: 'room_not_earth' })
    return outcome(name, false, true, 'room_not_earth')
  }

  const identityRaw = event.participant?.identity
  const identity =
    identityRaw !== undefined && parseMediaIdentity(identityRaw) !== null ? identityRaw : null
  if (name !== 'room_finished' && identity === null) {
    deps.logger.warn(WEBHOOK_LOG.ignored, { event: name, roomId, reason: 'identity_not_earth' })
    return outcome(name, false, true, 'identity_not_earth')
  }

  const at = webhookEventAt(event, deps.now())
  try {
    const result = await rpcAdmin(
      deps,
      ROOM_PARTICIPANT_SYNC_RPC,
      { room_id: roomId, livekit_identity: identity, event: name, at },
      AnyRpcResultSchema,
    )
    if (isOutOfOrder(result)) {
      deps.logger.warn(WEBHOOK_LOG.outOfOrder, {
        kind: 'webhook_out_of_order',
        roomId,
        participantIdentity: identity,
        eventType: name,
        eventId: event.id,
      })
      return outcome(name, true, true, 'out_of_order')
    }
    return outcome(name, true, true)
  } catch (cause) {
    const code = cause instanceof EarthError ? cause.code : 'internal'
    deps.logger.error(WEBHOOK_LOG.syncFailed, { event: name, roomId, code, error: cause })
    return outcome(name, true, false, code)
  }
}
