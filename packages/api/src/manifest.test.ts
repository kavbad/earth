import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { type EarthClient, createEarthClient } from './client'
import {
  CALLS,
  MANIFEST_RPC_NAMES,
  RPC_MANIFEST,
  type RpcManifestEntry,
  manifestEntry,
} from './manifest'
import { ROUTE_TEMPLATES, RPC, SERVER_ROUTES, SERVER_TIER_RPCS, TABLES } from './rpc'
import { createFakeFetch } from './testing/fake-fetch'
import { createFakeSupabase } from './testing/fake-supabase'

/** Every function reachable on the client, as `namespace.method` paths (nested namespaces included). */
function clientMethods(client: EarthClient): string[] {
  const out: string[] = []
  const walk = (value: object, prefix: string): void => {
    for (const [key, member] of Object.entries(value)) {
      const name = prefix === '' ? key : `${prefix}.${key}`
      if (typeof member === 'function') out.push(name)
      else if (typeof member === 'object' && member !== null) walk(member, name)
    }
  }
  const { accessToken: _token, transport: _transport, ...namespaces } = client
  walk(namespaces, '')
  return out.sort()
}

const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/

describe('RPC_MANIFEST', () => {
  const client = createEarthClient({
    supabase: createFakeSupabase(),
    serverBaseUrl: 'https://api.earth.test',
    fetch: createFakeFetch().fetch,
  })

  it('lists every namespace method exactly once, and nothing else', () => {
    const methods = RPC_MANIFEST.map((entry) => entry.method)
    expect(new Set(methods).size).toBe(methods.length)
    expect([...methods].sort()).toEqual(clientMethods(client))
  })

  it('is derived from CALLS (one entry per spec, in order, without schemas)', () => {
    expect(RPC_MANIFEST).toEqual(Object.values(CALLS).map(manifestEntry))
    for (const entry of RPC_MANIFEST) expect(entry).not.toHaveProperty('schema')
  })

  it('names every RPC constant the client owns, and only those', () => {
    const clientRpcs = new Set(Object.values(RPC))
    expect([...MANIFEST_RPC_NAMES].sort()).toEqual([...clientRpcs].sort())
    for (const name of MANIFEST_RPC_NAMES) expect(SERVER_TIER_RPCS).not.toContain(name)
    for (const name of SERVER_TIER_RPCS) expect(name).toMatch(SNAKE_CASE)
  })

  it('sends snake_case argument names to RPCs and names a result for every entry', () => {
    for (const entry of RPC_MANIFEST) {
      expect(entry.result.length).toBeGreaterThan(0)
      if (entry.rpc === null) continue
      expect(entry.route).toBeNull()
      for (const arg of entry.args) expect(arg).toMatch(SNAKE_CASE)
      expect(new Set(entry.args).size).toBe(entry.args.length)
    }
  })

  it('route entries use the templates SERVER_ROUTES fills', () => {
    const routes = RPC_MANIFEST.filter((entry) => entry.route !== null)
    const templates = new Set<string>(Object.values(ROUTE_TEMPLATES))
    for (const entry of routes) {
      const [method, template] = (entry.route as string).split(' ')
      expect(['GET', 'POST']).toContain(method)
      expect(templates.has(template as string)).toBe(true)
    }
    expect(SERVER_ROUTES.roomToken('r 1')).toBe('/api/rooms/r%201/token')
    expect(SERVER_ROUTES.claimVerificationResult('s/1')).toBe('/api/claim/verification/s%2F1')
    expect(routes.map((entry) => entry.route).sort()).toEqual(
      [
        'GET /api/claim/verification/:sessionId',
        'GET /api/feed',
        'GET /api/live',
        'POST /api/account/delete',
        'POST /api/analytics/ingest',
        'POST /api/claim/verification/start',
        'POST /api/diagnostics/rtc',
        'POST /api/rooms/:id/token',
      ].sort(),
    )
  })

  it('table entries name the tables/views the client reads or inserts', () => {
    const tables = RPC_MANIFEST.filter((entry) => entry.kind === 'table')
    expect(new Set(tables.map((entry) => entry.table))).toEqual(new Set(Object.values(TABLES)))
    for (const entry of tables) expect(entry.args.length).toBeGreaterThan(0)
  })

  it('composite entries point at methods that exist', () => {
    const methods = new Set(RPC_MANIFEST.map((entry) => entry.method))
    for (const entry of RPC_MANIFEST.filter((e) => e.kind === 'composite')) {
      expect(entry.via?.length).toBeGreaterThan(0)
      for (const via of entry.via ?? []) {
        if (via.startsWith('storage.')) continue
        expect(methods.has(via)).toBe(true)
      }
    }
  })

  it('is JSON-serializable', () => {
    const roundTrip = JSON.parse(JSON.stringify(RPC_MANIFEST)) as RpcManifestEntry[]
    expect(roundTrip).toEqual(RPC_MANIFEST)
  })

  it('is what README.md documents (every method and RPC / route appears in the table)', () => {
    const readme = readFileSync(path.join(import.meta.dirname, '..', 'README.md'), 'utf8')
    for (const entry of RPC_MANIFEST) {
      expect(readme).toContain(`\`${entry.method}(`)
      if (entry.rpc !== null) expect(readme).toContain(`\`${entry.rpc}(`)
      if (entry.route !== null) expect(readme).toContain(`\`${entry.route}\``)
    }
  })
})
