/**
 * An `EarthClient` for a build without a valid environment: every method rejects with
 * `EarthError('internal')`. Screens never call the client during render (queries and effects run
 * after mount), so this only ever answers a misconfiguration, visibly, instead of crashing.
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
      return stubNamespace(`${path}.${String(property)}`)
    },
    apply(target) {
      return target()
    },
  })
}

export function createStubEarthClient(): EarthClient {
  return stubNamespace('earth') as EarthClient
}
