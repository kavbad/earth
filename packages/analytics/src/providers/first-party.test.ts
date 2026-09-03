import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ANALYTICS_INGEST_MAX_EVENTS, AnalyticsIngestBatchSchema } from '../ingest'
import {
  createFirstPartyProvider,
  type FetchLike,
  type FirstPartyDrop,
  FIRST_PARTY_DROP_REASONS,
  FIRST_PARTY_FLUSH_INTERVAL_MS,
  FIRST_PARTY_MAX_BATCH_SIZE,
  HTTP_STATUS_TOO_MANY_REQUESTS,
} from './first-party'

interface Call {
  url: string
  init: Parameters<FetchLike>[1]
}

function fakeFetch(
  responder: (call: Call, index: number) => Promise<{ ok: boolean; status: number }>,
) {
  const calls: Call[] = []
  const fetch: FetchLike = (url, init) => {
    const call = { url, init }
    calls.push(call)
    return responder(call, calls.length - 1)
  }
  return { fetch, calls }
}

const ok = async () => ({ ok: true, status: 202 })

const batchSizes = (calls: Call[]) =>
  calls.map((c) => (JSON.parse(c.init.body) as { events: unknown[] }).events.length)

describe('first-party provider', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-03T10:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushes when the batch reaches 20 events, posting a valid ingest batch', async () => {
    const { fetch, calls } = fakeFetch(ok)
    const provider = createFirstPartyProvider({
      apiBaseUrl: 'https://earth.social/',
      fetch,
      getAccessToken: () => 'token-1',
    })
    for (let i = 0; i < FIRST_PARTY_MAX_BATCH_SIZE - 1; i += 1) {
      provider.capture('post_impression', { postId: `p${i}`, position: i })
    }
    expect(calls).toHaveLength(0)
    expect(provider.pending).toBe(19)

    provider.capture('post_impression', { postId: 'p19', position: 19 })
    await vi.advanceTimersByTimeAsync(0)

    expect(calls).toHaveLength(1)
    expect(provider.pending).toBe(0)
    const [call] = calls
    expect(call?.url).toBe('https://earth.social/api/analytics/ingest')
    expect(call?.init.method).toBe('POST')
    expect(call?.init.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer token-1',
    })
    expect('keepalive' in (call?.init ?? {})).toBe(false)
    const parsed = AnalyticsIngestBatchSchema.parse(JSON.parse(call?.init.body ?? ''))
    expect(parsed.v).toBe(1)
    expect(parsed.sentAt).toBe('2026-09-03T10:00:00.000Z')
    expect(parsed.events).toHaveLength(20)
    expect(parsed.events[0]).toEqual({
      name: 'post_impression',
      properties: { postId: 'p0', position: 0 },
    })
  })

  it('flushes after 5 seconds when the batch is small', async () => {
    const { fetch, calls } = fakeFetch(ok)
    const provider = createFirstPartyProvider({ apiBaseUrl: 'https://earth.social', fetch })
    provider.capture('feed_opened', { scope: 'world' })
    provider.capture('scope_changed', { from: 'world', to: 'city' })

    await vi.advanceTimersByTimeAsync(FIRST_PARTY_FLUSH_INTERVAL_MS - 1)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.init.headers).toEqual({ 'content-type': 'application/json' })
    expect(JSON.parse(calls[0]?.init.body ?? '').events).toHaveLength(2)
    expect(provider.pending).toBe(0)
  })

  it('unrefs the flush timer so a pending batch never holds a process open', () => {
    const unref = vi.fn()
    const fakeHandle = { unref, ref: () => undefined, hasRef: () => true }
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((() => fakeHandle) as unknown as typeof setTimeout)
    try {
      const { fetch } = fakeFetch(ok)
      const provider = createFirstPartyProvider({ apiBaseUrl: 'https://earth.social', fetch })
      provider.capture('feed_opened', { scope: 'world' })
      provider.capture('feed_opened', { scope: 'city' })
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
      expect(unref).toHaveBeenCalledTimes(1)
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  it('flush() sends everything in batch-sized requests and is safe to call concurrently', async () => {
    const { fetch, calls } = fakeFetch(ok)
    const provider = createFirstPartyProvider({
      apiBaseUrl: 'https://earth.social',
      fetch,
      maxBatchSize: 3,
      flushIntervalMs: 60_000,
    })
    for (let i = 0; i < 2; i += 1) provider.capture('feed_opened', { i })
    await provider.flush()
    expect(calls).toHaveLength(1)

    // Reaching the batch size schedules an auto flush; the 4th event lands before it drains.
    for (let i = 0; i < 2; i += 1) provider.capture('feed_opened', { i })
    for (let i = 0; i < 2; i += 1) provider.capture('post_opened', { i })
    expect(calls).toHaveLength(1)
    await Promise.all([provider.flush(), provider.flush()])

    expect(batchSizes(calls)).toEqual([2, 3, 1])
    expect(provider.pending).toBe(0)
  })

  it('clamps maxBatchSize to the ingest maximum and keeps capture order across batches', async () => {
    const { fetch, calls } = fakeFetch(ok)
    const provider = createFirstPartyProvider({
      apiBaseUrl: 'https://earth.social',
      fetch,
      maxBatchSize: ANALYTICS_INGEST_MAX_EVENTS * 10,
      maxQueueSize: 1_000,
    })
    for (let i = 0; i < 150; i += 1) provider.capture('post_impression', { position: i })
    await provider.flush()
    expect(batchSizes(calls)).toEqual([ANALYTICS_INGEST_MAX_EVENTS, 50])
    const positions = calls.flatMap((c) =>
      (JSON.parse(c.init.body) as { events: { properties: { position: number } }[] }).events.map(
        (e) => e.properties.position,
      ),
    )
    expect(positions).toEqual(Array.from({ length: 150 }, (_, i) => i))
    for (const call of calls) {
      expect(AnalyticsIngestBatchSchema.safeParse(JSON.parse(call.init.body)).success).toBe(true)
    }
  })

  it('treats a batch size below 1 (or non-finite) as 1', async () => {
    const { fetch, calls } = fakeFetch(ok)
    const provider = createFirstPartyProvider({
      apiBaseUrl: 'https://earth.social',
      fetch,
      maxBatchSize: 0,
    })
    provider.capture('feed_opened', { i: 0 })
    provider.capture('feed_opened', { i: 1 })
    await provider.flush()
    expect(batchSizes(calls)).toEqual([1, 1])

    const nan = fakeFetch(ok)
    const p2 = createFirstPartyProvider({
      apiBaseUrl: 'https://earth.social',
      fetch: nan.fetch,
      maxBatchSize: Number.NaN,
    })
    p2.capture('feed_opened', { i: 0 })
    await p2.flush()
    expect(batchSizes(nan.calls)).toEqual([1])
  })

  it('a queue cap below the batch size still delivers on the interval flush', async () => {
    const drops: FirstPartyDrop[] = []
    const { fetch, calls } = fakeFetch(ok)
    const provider = createFirstPartyProvider({
      apiBaseUrl: 'https://earth.social',
      fetch,
      maxBatchSize: 10,
      maxQueueSize: 2,
      onDrop: (drop) => drops.push(drop),
    })
    for (let i = 0; i < 3; i += 1) provider.capture('feed_opened', { i })
    expect(provider.pending).toBe(2)
    expect(drops.map((d) => d.reason)).toEqual(['overflow'])
    await vi.advanceTimersByTimeAsync(FIRST_PARTY_FLUSH_INTERVAL_MS)
    expect(batchSizes(calls)).toEqual([2])
    expect(provider.pending).toBe(0)
  })

  it('drops the batch on 4xx without retrying and reports it', async () => {
    const drops: FirstPartyDrop[] = []
    const { fetch, calls } = fakeFetch(async () => ({ ok: false, status: 400 }))
    const provider = createFirstPartyProvider({
      apiBaseUrl: 'https://earth.social',
      fetch,
      onDrop: (drop) => drops.push(drop),
    })
    provider.capture('feed_opened', { scope: 'friends' })
    await provider.flush()
    expect(calls).toHaveLength(1)
    expect(drops).toEqual([
      {
        reason: 'rejected',
        status: 400,
        events: [{ name: 'feed_opened', properties: { scope: 'friends' } }],
      },
    ])
    expect(provider.pending).toBe(0)
  })

  it('reports 429 as rate_limited: dropped, never retried', async () => {
    const drops: FirstPartyDrop[] = []
    const { fetch, calls } = fakeFetch(async () => ({
      ok: false,
      status: HTTP_STATUS_TOO_MANY_REQUESTS,
    }))
    const provider = createFirstPartyProvider({
      apiBaseUrl: 'https://earth.social',
      fetch,
      onDrop: (drop) => drops.push(drop),
    })
    provider.capture('feed_opened', { scope: 'friends' })
    await provider.flush()
    expect(calls).toHaveLength(1)
    expect(drops).toEqual([
      {
        reason: 'rate_limited',
        status: 429,
        events: [{ name: 'feed_opened', properties: { scope: 'friends' } }],
      },
    ])
    expect(FIRST_PARTY_DROP_REASONS).toContain('rate_limited')
  })

  it('retries once on network error, then delivers', async () => {
    const { fetch, calls } = fakeFetch(async (_call, index) => {
      if (index === 0) throw new TypeError('network down')
      return { ok: true, status: 202 }
    })
    const drops: FirstPartyDrop[] = []
    const provider = createFirstPartyProvider({
      apiBaseUrl: 'https://earth.social',
      fetch,
      onDrop: (drop) => drops.push(drop),
    })
    provider.capture('feed_opened', { scope: 'friends' })
    await provider.flush()
    expect(calls).toHaveLength(2)
    expect(drops).toHaveLength(0)
  })

  it('drops after the single retry also fails (network) and on repeated 5xx', async () => {
    const drops: FirstPartyDrop[] = []
    const network = fakeFetch(async () => {
      throw new TypeError('network down')
    })
    const p1 = createFirstPartyProvider({
      apiBaseUrl: 'https://earth.social',
      fetch: network.fetch,
      onDrop: (drop) => drops.push(drop),
    })
    p1.capture('feed_opened', { scope: 'friends' })
    await p1.flush()
    expect(network.calls).toHaveLength(2)
    expect(drops[0]?.reason).toBe('network')
    expect(drops[0]?.error).toBeInstanceOf(TypeError)

    const server = fakeFetch(async () => ({ ok: false, status: 503 }))
    const p2 = createFirstPartyProvider({
      apiBaseUrl: 'https://earth.social',
      fetch: server.fetch,
      onDrop: (drop) => drops.push(drop),
    })
    p2.capture('feed_opened', { scope: 'friends' })
    await p2.flush()
    expect(server.calls).toHaveLength(2)
    expect(drops[1]).toMatchObject({ reason: 'server_error', status: 503 })
  })

  it('sends anonymously (no retry, no drop) when the access-token getter fails', async () => {
    const drops: FirstPartyDrop[] = []
    const sync = fakeFetch(ok)
    const p1 = createFirstPartyProvider({
      apiBaseUrl: 'https://earth.social',
      fetch: sync.fetch,
      getAccessToken: () => {
        throw new Error('session storage unavailable')
      },
      onDrop: (drop) => drops.push(drop),
    })
    p1.capture('feed_opened', { scope: 'friends' })
    await p1.flush()
    expect(sync.calls).toHaveLength(1)
    expect(sync.calls[0]?.init.headers).toEqual({ 'content-type': 'application/json' })

    const async = fakeFetch(ok)
    const p2 = createFirstPartyProvider({
      apiBaseUrl: 'https://earth.social',
      fetch: async.fetch,
      getAccessToken: () => Promise.reject(new Error('expired')),
      onDrop: (drop) => drops.push(drop),
    })
    p2.capture('feed_opened', { scope: 'friends' })
    await p2.flush()
    expect(async.calls).toHaveLength(1)
    expect(async.calls[0]?.init.headers).toEqual({ 'content-type': 'application/json' })
    expect(drops).toEqual([])
  })

  it('omits the authorization header for empty or missing tokens', async () => {
    const { fetch, calls } = fakeFetch(ok)
    const provider = createFirstPartyProvider({
      apiBaseUrl: 'https://earth.social',
      fetch,
      getAccessToken: async () => '',
    })
    provider.capture('feed_opened', { scope: 'friends' })
    await provider.flush()
    expect(calls[0]?.init.headers).toEqual({ 'content-type': 'application/json' })
  })

  it('sets keepalive on requests only when asked to', async () => {
    const { fetch, calls } = fakeFetch(ok)
    const provider = createFirstPartyProvider({
      apiBaseUrl: 'https://earth.social',
      fetch,
      keepalive: true,
    })
    provider.capture('feed_opened', { scope: 'friends' })
    await provider.flush()
    expect(calls[0]?.init.keepalive).toBe(true)
  })

  it('caps the queue, dropping the oldest events', async () => {
    const drops: FirstPartyDrop[] = []
    const { fetch } = fakeFetch(ok)
    const provider = createFirstPartyProvider({
      apiBaseUrl: 'https://earth.social',
      fetch,
      maxBatchSize: 100,
      maxQueueSize: 3,
      onDrop: (drop) => drops.push(drop),
    })
    for (let i = 0; i < 5; i += 1) provider.capture('feed_opened', { i })
    expect(provider.pending).toBe(3)
    expect(drops.map((d) => d.reason)).toEqual(['overflow', 'overflow'])
    expect(drops.flatMap((d) => d.events.map((e) => e.properties['i']))).toEqual([0, 1])
  })

  it('a throwing onDrop handler never breaks delivery', async () => {
    const { fetch, calls } = fakeFetch(async (_call, index) => ({
      ok: index > 0,
      status: index > 0 ? 202 : 400,
    }))
    const provider = createFirstPartyProvider({
      apiBaseUrl: 'https://earth.social',
      fetch,
      onDrop: () => {
        throw new Error('diagnostics down')
      },
    })
    provider.capture('feed_opened', { scope: 'friends' })
    await provider.flush()
    provider.capture('feed_opened', { scope: 'city' })
    await provider.flush()
    expect(calls).toHaveLength(2)
    expect(provider.pending).toBe(0)
  })

  it('reset() flushes instead of discarding', async () => {
    const { fetch, calls } = fakeFetch(ok)
    const provider = createFirstPartyProvider({ apiBaseUrl: 'https://earth.social', fetch })
    provider.capture('feed_opened', { scope: 'friends' })
    provider.reset()
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
  })
})
