import http from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DEFAULT_HOST,
  DEFAULT_PORTS,
  GATEWAY_SERVICE_NAME,
  PREFIXES,
  ROUTE_KINDS,
  UNAVAILABLE_STATUS,
  optionsFromEnv,
  resolveRoute,
  startGateway,
  stripPrefix,
  type RunningGateway,
} from './gateway.mjs'

describe('stripPrefix', () => {
  it('removes the prefix and keeps a leading slash', () => {
    expect(stripPrefix('/rest/v1/rpc/x', PREFIXES.rest)).toBe('/rpc/x')
    expect(stripPrefix('/rest/v1/', PREFIXES.rest)).toBe('/')
    expect(stripPrefix('/rest/v1', PREFIXES.rest)).toBe('/')
  })
})

describe('resolveRoute', () => {
  it.each([
    [
      '/rest/v1/rpc/group_create?x=1',
      { kind: ROUTE_KINDS.proxy, service: 'rest', path: '/rpc/group_create?x=1' },
    ],
    ['/rest/v1', { kind: ROUTE_KINDS.proxy, service: 'rest', path: '/' }],
    ['/rest/v1/', { kind: ROUTE_KINDS.proxy, service: 'rest', path: '/' }],
    ['/rest/v1/?select=*', { kind: ROUTE_KINDS.proxy, service: 'rest', path: '/?select=*' }],
    ['/auth/v1/health', { kind: ROUTE_KINDS.proxy, service: 'auth', path: '/health' }],
    ['/auth/v1/otp', { kind: ROUTE_KINDS.proxy, service: 'auth', path: '/otp' }],
    [
      '/storage/v1/object/avatars/a.png',
      { kind: ROUTE_KINDS.unavailable, service: 'storage', status: 501 },
    ],
    [
      '/realtime/v1/websocket?apikey=k',
      { kind: ROUTE_KINDS.unavailable, service: 'realtime', status: 503 },
    ],
    [
      '/local/mail-templates/magic-link.html',
      { kind: ROUTE_KINDS.template, name: 'magic-link.html' },
    ],
    ['/health', { kind: ROUTE_KINDS.health }],
    ['/', { kind: ROUTE_KINDS.health }],
  ])('%s', (url, expected) => {
    expect(resolveRoute(url)).toEqual(expected)
  })

  it('only matches whole path segments and safe template names', () => {
    expect(resolveRoute('/rest/v1x/table')).toEqual({ kind: ROUTE_KINDS.notFound })
    expect(resolveRoute('/authority')).toEqual({ kind: ROUTE_KINDS.notFound })
    expect(resolveRoute('/local/mail-templates/../secret.html')).toEqual({
      kind: ROUTE_KINDS.notFound,
    })
    expect(resolveRoute('/local/mail-templates/notes.txt')).toEqual({ kind: ROUTE_KINDS.notFound })
    expect(resolveRoute('/local/mail-templates/')).toEqual({ kind: ROUTE_KINDS.notFound })
    expect(resolveRoute('/nope')).toEqual({ kind: ROUTE_KINDS.notFound })
  })

  it('uses the documented unavailable statuses', () => {
    expect(UNAVAILABLE_STATUS).toEqual({ storage: 501, realtime: 503 })
  })
})

interface EchoBody {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

/** Upstream stand-in that echoes the request it received. */
function startEcho(name: string): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
    })
    req.on('end', () => {
      const payload: EchoBody = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      }
      res.writeHead(name === 'rest' ? 201 : 200, {
        'content-type': 'application/json',
        'x-upstream': name,
      })
      res.end(JSON.stringify(payload))
    })
  })
  return new Promise((resolve) => {
    server.listen(0, DEFAULT_HOST, () => {
      const address = server.address() as net.AddressInfo
      resolve({ server, port: address.port })
    })
  })
}

async function freePort(): Promise<number> {
  const probe = await startEcho('probe')
  await new Promise<void>((resolve) => probe.server.close(() => resolve()))
  return probe.port
}

describe('gateway', () => {
  let rest: { server: http.Server; port: number }
  let auth: { server: http.Server; port: number }
  let gateway: RunningGateway
  let templatesDir: string
  const logs: string[] = []

  beforeAll(async () => {
    ;[rest, auth] = await Promise.all([startEcho('rest'), startEcho('auth')])
    templatesDir = await mkdtemp(path.join(os.tmpdir(), 'earth-gateway-'))
    await writeFile(path.join(templatesDir, 'magic-link.html'), '<p>{{ .Token }}</p>')
    gateway = await startGateway({
      port: 0,
      upstreams: {
        rest: { host: DEFAULT_HOST, port: rest.port },
        auth: { host: DEFAULT_HOST, port: auth.port },
      },
      templatesDir,
      log: (line) => logs.push(line),
    })
  })

  afterAll(async () => {
    await gateway.close()
    await Promise.all([
      new Promise<void>((resolve) => rest.server.close(() => resolve())),
      new Promise<void>((resolve) => auth.server.close(() => resolve())),
    ])
    await rm(templatesDir, { recursive: true, force: true })
  })

  const base = (): string => `http://${DEFAULT_HOST}:${gateway.port}`

  it('proxies /rest/v1 to PostgREST with the prefix stripped and headers passed through', async () => {
    const response = await fetch(`${base()}/rest/v1/rpc/group_create?select=id`, {
      method: 'POST',
      headers: {
        apikey: 'anon-key',
        authorization: 'Bearer user-jwt',
        'content-type': 'application/json',
        prefer: 'return=representation',
      },
      body: JSON.stringify({ name: 'Weekend Crew' }),
    })
    expect(response.status).toBe(201)
    expect(response.headers.get('x-upstream')).toBe('rest')
    const echoed = (await response.json()) as EchoBody
    expect(echoed.method).toBe('POST')
    expect(echoed.url).toBe('/rpc/group_create?select=id')
    expect(echoed.headers['apikey']).toBe('anon-key')
    expect(echoed.headers['authorization']).toBe('Bearer user-jwt')
    expect(echoed.headers['prefer']).toBe('return=representation')
    expect(echoed.headers['host']).toBe(`${DEFAULT_HOST}:${rest.port}`)
    expect(JSON.parse(echoed.body)).toEqual({ name: 'Weekend Crew' })
  })

  it('proxies /auth/v1 to GoTrue', async () => {
    const response = await fetch(`${base()}/auth/v1/health`)
    expect(response.status).toBe(200)
    expect(response.headers.get('x-upstream')).toBe('auth')
    const echoed = (await response.json()) as EchoBody
    expect(echoed.url).toBe('/health')
    expect(echoed.method).toBe('GET')
  })

  it('answers CORS preflights for proxied routes itself, echoing the requested headers', async () => {
    // GoTrue rejects a preflight that asks for `apikey` (no allow-origin); browsers would then
    // block every supabase-js auth call, so the gateway answers preflights like the hosted edge.
    const preflight = await fetch(`${base()}/auth/v1/otp?redirect_to=x`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'apikey,authorization,content-type,x-client-info',
      },
    })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('x-upstream')).toBeNull()
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
    expect(preflight.headers.get('access-control-allow-headers')).toBe(
      'apikey,authorization,content-type,x-client-info',
    )
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST')

    const rest = await fetch(`${base()}/rest/v1/rpc/me_get`, { method: 'OPTIONS' })
    expect(rest.status).toBe(204)
    expect(rest.headers.get('access-control-allow-headers')).toBe('*')
  })

  it('answers Storage with 501 and Realtime with 503, with CORS headers', async () => {
    const storage = await fetch(`${base()}/storage/v1/object/avatars/a.png`)
    expect(storage.status).toBe(501)
    expect(storage.headers.get('access-control-allow-origin')).toBe('*')
    await expect(storage.json()).resolves.toMatchObject({ error: 'storage_unavailable' })

    const realtime = await fetch(`${base()}/realtime/v1/api/broadcast`, {
      method: 'POST',
      body: '{}',
    })
    expect(realtime.status).toBe(503)
    await expect(realtime.json()).resolves.toMatchObject({ error: 'realtime_unavailable' })

    const preflight = await fetch(`${base()}/storage/v1/object`, { method: 'OPTIONS' })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST')
  })

  it('refuses websocket upgrades (Realtime) with an HTTP 503 so clients fall back to polling', async () => {
    const received = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(gateway.port, DEFAULT_HOST, () => {
        socket.write(
          'GET /realtime/v1/websocket?apikey=k HTTP/1.1\r\n' +
            `Host: ${DEFAULT_HOST}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        )
      })
      let data = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        data += chunk
      })
      socket.on('close', () => resolve(data))
      socket.on('error', reject)
    })
    expect(received.startsWith('HTTP/1.1 503')).toBe(true)
    expect(received).toContain('websocket_unavailable')
  })

  it('serves mail templates and 404s unknown ones', async () => {
    const found = await fetch(`${base()}/local/mail-templates/magic-link.html`)
    expect(found.status).toBe(200)
    expect(found.headers.get('content-type')).toContain('text/html')
    await expect(found.text()).resolves.toBe('<p>{{ .Token }}</p>')

    const missing = await fetch(`${base()}/local/mail-templates/nope.html`)
    expect(missing.status).toBe(404)
  })

  it('reports health and 404s everything else', async () => {
    const health = await fetch(`${base()}/health`)
    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toMatchObject({ ok: true, service: GATEWAY_SERVICE_NAME })

    const unknown = await fetch(`${base()}/elsewhere`)
    expect(unknown.status).toBe(404)
    expect(logs.some((line) => line.includes('GET /elsewhere -> 404'))).toBe(true)
  })

  it('returns 502 JSON when an upstream is down', async () => {
    const deadPort = await freePort()
    const lonely = await startGateway({
      port: 0,
      upstreams: {
        rest: { host: DEFAULT_HOST, port: deadPort },
        auth: { host: DEFAULT_HOST, port: deadPort },
      },
      log: () => undefined,
    })
    try {
      const response = await fetch(`http://${DEFAULT_HOST}:${lonely.port}/rest/v1/`)
      expect(response.status).toBe(502)
      await expect(response.json()).resolves.toMatchObject({ error: 'upstream_unavailable' })
    } finally {
      await lonely.close()
    }
  })
})

describe('optionsFromEnv', () => {
  it('defaults to the documented ports and loopback', () => {
    expect(optionsFromEnv({})).toEqual({
      host: DEFAULT_HOST,
      port: DEFAULT_PORTS.gateway,
      upstreams: {
        rest: { host: DEFAULT_HOST, port: DEFAULT_PORTS.postgrest },
        auth: { host: DEFAULT_HOST, port: DEFAULT_PORTS.gotrue },
      },
    })
  })

  it('reads overrides and rejects garbage ports', () => {
    expect(
      optionsFromEnv({
        EARTH_PORT_GATEWAY: '1',
        EARTH_PORT_POSTGREST: '2',
        EARTH_PORT_GOTRUE: '3',
        EARTH_GATEWAY_HOST: '0.0.0.0',
        EARTH_UPSTREAM_HOST: 'db.internal',
      }),
    ).toEqual({
      host: '0.0.0.0',
      port: 1,
      upstreams: { rest: { host: 'db.internal', port: 2 }, auth: { host: 'db.internal', port: 3 } },
    })
    expect(() => optionsFromEnv({ EARTH_PORT_GATEWAY: 'eighty' })).toThrow(/not a port/)
    expect(optionsFromEnv({ EARTH_PORT_GATEWAY: '' }).port).toBe(DEFAULT_PORTS.gateway)
  })
})
