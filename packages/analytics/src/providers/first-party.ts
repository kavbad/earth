/**
 * First-party provider: batches events and POSTs them to `API_BASE_URL + /api/analytics/ingest`
 * (ARCHITECTURE §6) so the mission-critical metrics (`../metrics.ts`) never depend on a vendor.
 *
 * Behaviour:
 * - queue; flush when the queue reaches `maxBatchSize` (20) or `flushIntervalMs` (5 s) after the
 *   first queued event, whichever comes first; `flush()` sends everything, oldest first, in
 *   ≤ batch-size requests, one request at a time (so the store sees events in capture order);
 * - `maxBatchSize` is clamped to `ANALYTICS_INGEST_MAX_EVENTS`: a larger batch would be refused
 *   wholesale by the route and every event in it lost;
 * - a 4xx response means the batch violates the contract: it is dropped and reported (`rejected`),
 *   except 429, which is reported as `rate_limited` — also dropped, never retried, so a rate-limited
 *   device does not hammer the route;
 * - a network error (fetch rejects) or a 5xx response is retried once, then dropped and reported;
 * - the queue is capped at `maxQueueSize` (oldest events dropped) so an offline device never grows
 *   memory without bound;
 * - a failing `getAccessToken` (expired session, storage error) is not a delivery failure: the
 *   batch is sent without a bearer token and the route treats it as anonymous;
 * - the flush timer is `unref`'d where the runtime supports it (Node) so a pending batch never
 *   keeps a process alive;
 * - `fetch` is injected so the provider is testable and runs on Node, browsers and React Native;
 *   `keepalive: true` lets a browser finish an unload-time flush after navigation.
 */
import type { EventName } from '../contract'
import {
  type AnalyticsEnvelope,
  type AnalyticsIngestBatch,
  ANALYTICS_INGEST_MAX_EVENTS,
  ANALYTICS_INGEST_VERSION,
  ingestUrl,
  wireProperties,
} from '../ingest'
import type { AnalyticsProperties, AnalyticsProvider } from '../provider'

export const FIRST_PARTY_PROVIDER_NAME = 'first-party' as const
export const FIRST_PARTY_MAX_BATCH_SIZE = 20
export const FIRST_PARTY_FLUSH_INTERVAL_MS = 5_000
export const FIRST_PARTY_MAX_QUEUE_SIZE = 500
export const FIRST_PARTY_NETWORK_RETRIES = 1
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429

export const FIRST_PARTY_DROP_REASONS = [
  'rejected',
  'rate_limited',
  'network',
  'server_error',
  'overflow',
] as const
export type FirstPartyDropReason = (typeof FIRST_PARTY_DROP_REASONS)[number]

export interface FirstPartyDrop {
  reason: FirstPartyDropReason
  events: readonly AnalyticsEnvelope[]
  status?: number
  error?: unknown
}

export interface FetchLikeInit {
  method: string
  headers: Record<string, string>
  body: string
  keepalive?: boolean
}

export type FetchLike = (
  input: string,
  init: FetchLikeInit,
) => Promise<{ ok: boolean; status: number }>

export interface FirstPartyProviderOptions {
  apiBaseUrl: string
  fetch: FetchLike
  /** Supabase access token for the caller, when signed in (route is rate limited per caller). */
  getAccessToken?: () => string | null | undefined | Promise<string | null | undefined>
  /** Events per request; clamped to `[1, ANALYTICS_INGEST_MAX_EVENTS]`. Default 20. */
  maxBatchSize?: number
  flushIntervalMs?: number
  /**
   * Queue cap (≥ 1); oldest events are dropped beyond it. Default 500. A cap below `maxBatchSize`
   * is allowed: batches then only ever leave on the interval flush.
   */
  maxQueueSize?: number
  /**
   * Send requests with `keepalive: true` (browsers keep the request alive across unload; bodies
   * are capped at 64 KiB in flight, which a 20-event batch of ids and enums never approaches).
   */
  keepalive?: boolean
  onDrop?: (drop: FirstPartyDrop) => void
  now?: () => number
}

export interface FirstPartyProvider extends AnalyticsProvider {
  flush(): Promise<void>
  /** Events waiting to be sent (for diagnostics and tests). */
  readonly pending: number
}

function isRetryable(status: number): boolean {
  return status >= 500
}

function isRejected(status: number): boolean {
  return status >= 400 && status < 500
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}

function unrefTimer(handle: unknown): void {
  if (typeof handle !== 'object' || handle === null) return
  const unref = (handle as { unref?: unknown }).unref
  if (typeof unref === 'function') (unref as () => void).call(handle)
}

export function createFirstPartyProvider(options: FirstPartyProviderOptions): FirstPartyProvider {
  const url = ingestUrl(options.apiBaseUrl)
  const maxBatchSize = clampInt(
    options.maxBatchSize ?? FIRST_PARTY_MAX_BATCH_SIZE,
    1,
    ANALYTICS_INGEST_MAX_EVENTS,
  )
  const flushIntervalMs = clampInt(
    options.flushIntervalMs ?? FIRST_PARTY_FLUSH_INTERVAL_MS,
    0,
    Number.MAX_SAFE_INTEGER,
  )
  const maxQueueSize = clampInt(
    options.maxQueueSize ?? FIRST_PARTY_MAX_QUEUE_SIZE,
    1,
    Number.MAX_SAFE_INTEGER,
  )
  const keepalive = options.keepalive ?? false
  // Read `Date.now` lazily so clocks installed later (fake timers, polyfills) are honoured.
  const now = options.now ?? (() => Date.now())
  const onDrop = options.onDrop ?? (() => undefined)

  const queue: AnalyticsEnvelope[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight: Promise<void> = Promise.resolve()

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const drop = (drop: FirstPartyDrop): void => {
    try {
      onDrop(drop)
    } catch {
      // never let diagnostics break delivery
    }
  }

  const accessToken = async (): Promise<string | undefined> => {
    try {
      const token = await options.getAccessToken?.()
      return typeof token === 'string' && token.length > 0 ? token : undefined
    } catch {
      // A broken session getter must not block delivery; the route treats the batch as anonymous.
      return undefined
    }
  }

  const post = async (
    events: readonly AnalyticsEnvelope[],
  ): Promise<{ ok: boolean; status: number }> => {
    const batch: AnalyticsIngestBatch = {
      v: ANALYTICS_INGEST_VERSION,
      sentAt: new Date(now()).toISOString(),
      events: [...events],
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    const token = await accessToken()
    if (token !== undefined) headers['authorization'] = `Bearer ${token}`
    const init: FetchLikeInit = { method: 'POST', headers, body: JSON.stringify(batch) }
    if (keepalive) init.keepalive = true
    return options.fetch(url, init)
  }

  const send = async (events: readonly AnalyticsEnvelope[]): Promise<void> => {
    let lastError: unknown
    let lastStatus: number | undefined
    for (let attempt = 0; attempt <= FIRST_PARTY_NETWORK_RETRIES; attempt += 1) {
      try {
        const response = await post(events)
        if (response.ok) return
        if (response.status === HTTP_STATUS_TOO_MANY_REQUESTS) {
          drop({ reason: 'rate_limited', events, status: response.status })
          return
        }
        if (isRejected(response.status)) {
          drop({ reason: 'rejected', events, status: response.status })
          return
        }
        lastStatus = response.status
        lastError = undefined
        if (!isRetryable(response.status)) break
      } catch (error) {
        lastError = error
        lastStatus = undefined
      }
    }
    drop(
      lastStatus === undefined
        ? { reason: 'network', events, error: lastError }
        : { reason: 'server_error', events, status: lastStatus },
    )
  }

  const drain = async (): Promise<void> => {
    while (queue.length > 0) {
      const batch = queue.splice(0, maxBatchSize)
      await send(batch)
    }
  }

  const flush = (): Promise<void> => {
    clearTimer()
    inFlight = inFlight.then(drain, drain)
    return inFlight
  }

  const schedule = (): void => {
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, flushIntervalMs)
    unrefTimer(timer)
  }

  return {
    name: FIRST_PARTY_PROVIDER_NAME,
    get pending() {
      return queue.length
    },
    identify: () => undefined,
    capture(name: EventName, properties: AnalyticsProperties) {
      if (queue.length >= maxQueueSize) {
        const overflow = queue.splice(0, queue.length - maxQueueSize + 1)
        drop({ reason: 'overflow', events: overflow })
      }
      queue.push({ name, properties: wireProperties(properties) })
      if (queue.length >= maxBatchSize) {
        void flush()
        return
      }
      schedule()
    },
    reset() {
      // Sign-out: deliver what the previous person did, keep nothing behind.
      void flush()
    },
    flush,
  }
}
