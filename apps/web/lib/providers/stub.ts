/**
 * An `EarthClient` for server rendering and for a browser without a valid environment: every
 * method rejects with `EarthError('internal')`. Screens never call the client during render
 * (queries and effects run on the client), so this only ever answers a programming error.
 */
import type { EarthClient } from '@earth/api'
import { EarthError } from '@earth/domain'

export const STUB_REASON = 'earth_client_unavailable' as const

function rejecting(path: string): () => Promise<never> {
  return () =>
    Promise.reject(
      new EarthError('internal', {
        details: { reason: STUB_REASON, path },
        message: `EarthClient is not available here (${path})`,
      }),
    )
}

function stubNamespace(path: string): unknown {
  return new Proxy(rejecting(path), {
    get(_target, property) {
      if (typeof property === 'symbol' || property === 'then') return undefined
      return stubNamespace(`${path}.${property}`)
    },
    apply(target) {
      return target()
    },
  })
}

export function createStubEarthClient(): EarthClient {
  return stubNamespace('earth') as EarthClient
}
