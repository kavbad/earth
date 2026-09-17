/**
 * Programmable `fetch` for the server-tier routes: records every request (URL, method, headers,
 * parsed JSON body) and answers with the configured status/body. Never touches the network.
 */
import type { ServerFetch, ServerFetchInit } from '../types'

export interface RecordedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly rawBody: string | undefined
  readonly body: unknown
}

export interface FakeResponseSpec {
  readonly status?: number | undefined
  /** JSON-serialised unless `text` is given. `undefined` → empty body. */
  readonly json?: unknown
  readonly text?: string | undefined
}

export type FakeFetchHandler = (
  request: RecordedRequest,
) => FakeResponseSpec | Promise<FakeResponseSpec>

export interface FakeFetch {
  readonly fetch: ServerFetch
  readonly requests: RecordedRequest[]
  /** Replaces the handler for subsequent requests. */
  respond(handler: FakeFetchHandler | FakeResponseSpec): void
  /** Makes subsequent requests reject with `error` (network failure). */
  fail(error: unknown): void
  lastRequest(): RecordedRequest
}

function parseBody(raw: string | undefined): unknown {
  if (raw === undefined || raw.length === 0) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function lowerCaseHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value
  return out
}

export function createFakeFetch(
  initial: FakeFetchHandler | FakeResponseSpec = { status: 200 },
): FakeFetch {
  let handler: FakeFetchHandler = typeof initial === 'function' ? initial : () => initial
  let failure: { error: unknown } | null = null
  const requests: RecordedRequest[] = []

  const fetch: ServerFetch = async (url: string, init: ServerFetchInit) => {
    const request: RecordedRequest = {
      url,
      method: init.method,
      headers: lowerCaseHeaders(init.headers),
      rawBody: init.body,
      body: parseBody(init.body),
    }
    requests.push(request)
    if (failure !== null) throw failure.error
    const spec = await handler(request)
    const status = spec.status ?? 200
    const text = spec.text ?? (spec.json === undefined ? '' : JSON.stringify(spec.json))
    return { ok: status >= 200 && status < 300, status, text: async () => text }
  }

  return {
    fetch,
    requests,
    respond(next) {
      failure = null
      handler = typeof next === 'function' ? next : () => next
    },
    fail(error) {
      failure = { error }
    },
    lastRequest() {
      const last = requests[requests.length - 1]
      if (last === undefined) throw new Error('no request recorded')
      return last
    },
  }
}
