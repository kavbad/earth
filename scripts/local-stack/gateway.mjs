#!/usr/bin/env node
/**
 * Supabase-shaped gateway for the local stack (scripts/local-stack/up.sh).
 *
 * supabase-js talks to one base URL and appends `/rest/v1`, `/auth/v1`, `/storage/v1` and
 * `/realtime/v1`; on hosted Supabase Kong does the routing. Locally this tiny reverse proxy does it:
 *
 *   /rest/v1/*               -> PostgREST (prefix stripped)
 *   /auth/v1/*               -> GoTrue (prefix stripped)
 *   /storage/v1/*            -> the local Storage service (storage.mjs) when the stack gave the
 *                              gateway a database URL and a JWT secret; 501 JSON otherwise
 *   /realtime/v1/*           -> 503 JSON (websocket upgrades refused): clients fall back to polling
 *   /local/mail-templates/*  -> GoTrue email templates (scripts/local-stack/mail-templates)
 *   /health                  -> 200 JSON
 *
 * Every header, including `apikey`, is passed through untouched. Plain JavaScript so `node` runs it
 * without a loader; types for tests live in gateway.d.mts.
 *
 *   node scripts/local-stack/gateway.mjs   (EARTH_PORT_GATEWAY, EARTH_PORT_POSTGREST, EARTH_PORT_GOTRUE,
 *                                           EARTH_GATEWAY_HOST, EARTH_UPSTREAM_HOST)
 */
/* global process, console, Buffer -- Node globals; the root ESLint config only declares them for .js/.cjs */
import { readFile } from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { createStorageService, storageOptionsFromEnv } from './storage.mjs'

export const GATEWAY_SERVICE_NAME = 'earth-local-gateway'

/** Repository root, so Storage defaults to `.local/storage` next to the other stack state. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export const ROUTE_KINDS = Object.freeze({
  proxy: 'proxy',
  storage: 'storage',
  unavailable: 'unavailable',
  template: 'template',
  health: 'health',
  notFound: 'not_found',
})

export const PROXIED_SERVICES = Object.freeze(['rest', 'auth'])
export const UNAVAILABLE_SERVICES = Object.freeze(['storage', 'realtime'])

export const PREFIXES = Object.freeze({
  rest: '/rest/v1',
  auth: '/auth/v1',
  storage: '/storage/v1',
  realtime: '/realtime/v1',
  templates: '/local/mail-templates',
  health: '/health',
})

/** 501 for Storage (never available locally), 503 for Realtime (clients retry/poll). */
export const UNAVAILABLE_STATUS = Object.freeze({ storage: 501, realtime: 503 })

/** Mirrors @earth/config LOCAL_PORTS and supabase/config.toml [api].port (checked in env.test.ts). */
export const DEFAULT_PORTS = Object.freeze({ gateway: 54321, postgrest: 3001, gotrue: 9999 })
export const DEFAULT_HOST = '127.0.0.1'

const TEMPLATE_NAME = /^[a-z0-9-]+\.html$/
const CORS_HEADERS = Object.freeze({
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
})

/** @param {string} pathname @param {string} prefix */
function hasPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/** `/rest/v1/rpc/x` -> `/rpc/x`; `/rest/v1` -> `/`. @param {string} pathname @param {string} prefix */
export function stripPrefix(pathname, prefix) {
  const rest = pathname.slice(prefix.length)
  return rest === '' ? '/' : rest
}

/**
 * Classifies a request URL (path + query). Pure so it is unit-tested without sockets. `/storage/v1`
 * is only routed to the Storage service when the stack configured one (`options.storage`); without
 * it the prefix stays unavailable, exactly as before Storage existed locally.
 * @param {string} url
 * @param {{ storage?: boolean }} [options]
 */
export function resolveRoute(url, options = {}) {
  const queryIndex = url.indexOf('?')
  const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex)
  const query = queryIndex === -1 ? '' : url.slice(queryIndex)

  if (options.storage === true && hasPrefix(pathname, PREFIXES.storage)) {
    return {
      kind: ROUTE_KINDS.storage,
      path: `${stripPrefix(pathname, PREFIXES.storage)}${query}`,
    }
  }
  for (const service of PROXIED_SERVICES) {
    const prefix = PREFIXES[service]
    if (hasPrefix(pathname, prefix)) {
      return { kind: ROUTE_KINDS.proxy, service, path: `${stripPrefix(pathname, prefix)}${query}` }
    }
  }
  for (const service of UNAVAILABLE_SERVICES) {
    if (hasPrefix(pathname, PREFIXES[service])) {
      return { kind: ROUTE_KINDS.unavailable, service, status: UNAVAILABLE_STATUS[service] }
    }
  }
  if (hasPrefix(pathname, PREFIXES.templates)) {
    const name = stripPrefix(pathname, PREFIXES.templates).slice(1)
    if (TEMPLATE_NAME.test(name)) return { kind: ROUTE_KINDS.template, name }
    return { kind: ROUTE_KINDS.notFound }
  }
  if (pathname === PREFIXES.health || pathname === '/') return { kind: ROUTE_KINDS.health }
  return { kind: ROUTE_KINDS.notFound }
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    ...CORS_HEADERS,
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ host: string, port: number }} target
 * @param {string} targetPath
 */
function proxy(req, res, target, targetPath) {
  const headers = { ...req.headers, host: `${target.host}:${target.port}` }
  const upstream = http.request(
    { host: target.host, port: target.port, method: req.method, path: targetPath, headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  upstream.on('error', (error) => {
    if (res.headersSent) {
      res.destroy()
      return
    }
    sendJson(res, 502, {
      error: 'upstream_unavailable',
      message: `${target.host}:${target.port} is not answering (${error.message}); is the local stack up?`,
    })
  })
  req.pipe(upstream)
}

/**
 * @param {{ upstreams: { rest: { host: string, port: number }, auth: { host: string, port: number } }, storage?: import('./storage.d.mts').StorageService, templatesDir?: string, log?: (line: string) => void }} options
 */
export function createGateway(options) {
  const templatesDir =
    options.templatesDir ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'mail-templates')
  const log = options.log ?? ((line) => console.log(`[gateway] ${line}`))
  const storage = options.storage

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    const method = req.method ?? 'GET'
    res.on('finish', () => log(`${method} ${url} -> ${res.statusCode}`))

    const route = resolveRoute(url, { storage: storage !== undefined })
    switch (route.kind) {
      case ROUTE_KINDS.proxy:
        // Browsers preflight every supabase-js request (`apikey`, `authorization`, ...). Hosted
        // Supabase answers those at its Kong edge; GoTrue on its own rejects a preflight that asks
        // for `apikey` (204 without allow-origin), so the gateway answers them itself.
        if (method === 'OPTIONS') {
          res.writeHead(204, {
            ...CORS_HEADERS,
            'access-control-allow-headers': req.headers['access-control-request-headers'] ?? '*',
            'access-control-max-age': '86400',
          })
          res.end()
          return
        }
        proxy(req, res, options.upstreams[route.service], route.path)
        return
      case ROUTE_KINDS.storage:
        // Storage answers its own preflights and errors (CORS headers included); the catch is the
        // last resort so a bug there closes the socket instead of taking the gateway down.
        storage.handle(req, res, route.path).catch((error) => {
          log(
            `storage failed on ${method} ${url}: ${error instanceof Error ? error.message : error}`,
          )
          res.destroy()
        })
        return
      case ROUTE_KINDS.unavailable:
        if (method === 'OPTIONS') {
          res.writeHead(204, CORS_HEADERS)
          res.end()
          return
        }
        sendJson(res, route.status, {
          error: `${route.service}_unavailable`,
          message: `Supabase ${route.service} is not part of the local stack (ARCHITECTURE.md §15)`,
        })
        return
      case ROUTE_KINDS.template:
        readFile(path.join(templatesDir, route.name), 'utf8').then(
          (html) => {
            res.writeHead(200, {
              'content-type': 'text/html; charset=utf-8',
              'content-length': Buffer.byteLength(html),
            })
            res.end(html)
          },
          () => sendJson(res, 404, { error: 'template_not_found', name: route.name }),
        )
        return
      case ROUTE_KINDS.health:
        sendJson(res, 200, {
          ok: true,
          service: GATEWAY_SERVICE_NAME,
          upstreams: options.upstreams,
        })
        return
      default:
        sendJson(res, 404, { error: 'not_found', path: url })
    }
  })

  // Websocket upgrades only ever target Realtime, which does not exist locally: refuse them right
  // away so @earth/realtime switches to its polling fallback instead of waiting for a join timeout.
  server.on('upgrade', (req, socket) => {
    const route = resolveRoute(req.url ?? '/')
    const status = route.kind === ROUTE_KINDS.unavailable ? route.status : 404
    const body = JSON.stringify({ error: 'websocket_unavailable', path: req.url ?? '/' })
    socket.write(
      `HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? ''}\r\n` +
        'connection: close\r\ncontent-type: application/json\r\n' +
        `content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    )
    socket.destroy()
    log(`UPGRADE ${req.url ?? '/'} -> ${status}`)
  })

  return server
}

/**
 * @param {{ port: number, host?: string, upstreams: { rest: { host: string, port: number }, auth: { host: string, port: number } }, storage?: import('./storage.d.mts').StorageService, templatesDir?: string, log?: (line: string) => void }} options
 */
export function startGateway(options) {
  const host = options.host ?? DEFAULT_HOST
  const server = createGateway(options)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, host, () => {
      server.off('error', reject)
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : options.port
      resolve({
        server,
        host,
        port,
        close: async () => {
          await new Promise((done) => {
            server.closeAllConnections()
            server.close(() => done(undefined))
          })
          if (options.storage !== undefined) await options.storage.close()
        },
      })
    })
  })
}

/** @param {NodeJS.ProcessEnv} env */
export function optionsFromEnv(env) {
  const upstreamHost = env.EARTH_UPSTREAM_HOST ?? DEFAULT_HOST
  const port = (name, fallback) => {
    const raw = env[name]
    if (raw === undefined || raw === '') return fallback
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 0 || value > 65535)
      throw new Error(`${name} is not a port: ${raw}`)
    return value
  }
  return {
    host: env.EARTH_GATEWAY_HOST ?? DEFAULT_HOST,
    port: port('EARTH_PORT_GATEWAY', DEFAULT_PORTS.gateway),
    upstreams: {
      rest: { host: upstreamHost, port: port('EARTH_PORT_POSTGREST', DEFAULT_PORTS.postgrest) },
      auth: { host: upstreamHost, port: port('EARTH_PORT_GOTRUE', DEFAULT_PORTS.gotrue) },
    },
    // Configuration only (no pool is opened here): null when the stack has no database URL or JWT
    // secret for Storage, in which case /storage/v1 keeps answering 501.
    storageOptions: storageOptionsFromEnv(env, REPO_ROOT),
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const { storageOptions, ...options } = optionsFromEnv(process.env)
  const storage =
    storageOptions === null
      ? undefined
      : createStorageService({
          ...storageOptions,
          log: (line) => console.log(`[storage] ${line}`),
        })
  startGateway({ ...options, storage }).then(
    (running) => {
      console.log(
        `[gateway] listening on http://${running.host}:${running.port} -> rest ${options.upstreams.rest.host}:${options.upstreams.rest.port}, auth ${options.upstreams.auth.host}:${options.upstreams.auth.port}, storage ${storage === undefined ? 'unavailable' : storageOptions.root}`,
      )
      const stop = () => running.close().then(() => process.exit(0))
      process.on('SIGTERM', stop)
      process.on('SIGINT', stop)
    },
    (error) => {
      console.error(
        `[gateway] failed to start: ${error instanceof Error ? error.message : String(error)}`,
      )
      process.exit(1)
    },
  )
}
