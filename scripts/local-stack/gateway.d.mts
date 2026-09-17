/** Types for gateway.mjs (plain JavaScript so `node` runs it without a loader). */
import type { Server } from 'node:http'

import type { StorageEnvOptions, StorageService } from './storage.d.mts'

export declare const GATEWAY_SERVICE_NAME: 'earth-local-gateway'

export declare const ROUTE_KINDS: {
  readonly proxy: 'proxy'
  readonly storage: 'storage'
  readonly unavailable: 'unavailable'
  readonly template: 'template'
  readonly health: 'health'
  readonly notFound: 'not_found'
}
export type RouteKind = (typeof ROUTE_KINDS)[keyof typeof ROUTE_KINDS]

export declare const PROXIED_SERVICES: readonly ['rest', 'auth']
export declare const UNAVAILABLE_SERVICES: readonly ['storage', 'realtime']
export type ProxiedService = (typeof PROXIED_SERVICES)[number]
export type UnavailableService = (typeof UNAVAILABLE_SERVICES)[number]

export declare const PREFIXES: {
  readonly rest: '/rest/v1'
  readonly auth: '/auth/v1'
  readonly storage: '/storage/v1'
  readonly realtime: '/realtime/v1'
  readonly templates: '/local/mail-templates'
  readonly health: '/health'
}
export declare const UNAVAILABLE_STATUS: { readonly storage: 501; readonly realtime: 503 }
export declare const DEFAULT_PORTS: {
  readonly gateway: 54321
  readonly postgrest: 3001
  readonly gotrue: 9999
}
export declare const DEFAULT_HOST: '127.0.0.1'

export type Route =
  | { kind: 'proxy'; service: ProxiedService; path: string }
  | { kind: 'storage'; path: string }
  | { kind: 'unavailable'; service: UnavailableService; status: number }
  | { kind: 'template'; name: string }
  | { kind: 'health' }
  | { kind: 'not_found' }

export declare function stripPrefix(pathname: string, prefix: string): string
export declare function resolveRoute(url: string, options?: { storage?: boolean }): Route

export interface Upstream {
  host: string
  port: number
}

export interface GatewayOptions {
  upstreams: Record<ProxiedService, Upstream>
  /** When given, `/storage/v1` is served by it instead of answering 501. */
  storage?: StorageService
  templatesDir?: string
  log?: (line: string) => void
}

export interface StartOptions extends GatewayOptions {
  port: number
  host?: string
}

export interface RunningGateway {
  server: Server
  host: string
  port: number
  close(): Promise<void>
}

export declare function createGateway(options: GatewayOptions): Server
export declare function startGateway(options: StartOptions): Promise<RunningGateway>
export declare function optionsFromEnv(
  env: NodeJS.ProcessEnv,
): Omit<StartOptions, 'storage'> & { host: string; storageOptions: StorageEnvOptions | null }
