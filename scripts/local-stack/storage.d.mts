/** Types for storage.mjs (plain JavaScript so `node` runs it without a loader). */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type pg from 'pg'

export declare const STORAGE_SERVICE_NAME: 'earth-local-storage'
export declare const STORAGE_ROLES: readonly ['anon', 'authenticated', 'service_role']
export declare const DEFAULT_SIGNED_URL_TTL_SECONDS: 3600
export declare const MAX_UPLOAD_BYTES: 104857600

export type ObjectRouteKind =
  | 'upload'
  | 'download'
  | 'download_public'
  | 'download_signed'
  | 'create_signed_url'
  | 'remove'
  | 'invalid_key'
  | 'not_found'

export interface ObjectRoute {
  kind: ObjectRouteKind
  bucket?: string
  key?: string
  query?: URLSearchParams
}

export declare function verifyToken(token: string, secret: string): Record<string, unknown> | null
export declare function mintSignedToken(
  secret: string,
  url: string,
  expiresInSeconds: number,
  now?: number,
): string
export declare function resolveObjectRoute(method: string, url: string): ObjectRoute
export declare function parseUploadBody(
  body: Buffer,
  contentType: string,
): Promise<{ bytes: Buffer; contentType: string }>
export declare function bearerOf(headers: NodeJS.Dict<string | string[]>): string | null

export interface StorageServiceOptions {
  /** An existing pool (tests); otherwise one is opened on `databaseUrl` and closed by `close()`. */
  pool?: pg.Pool
  databaseUrl?: string
  jwtSecret: string
  /** Directory the bytes live under (`.local/storage` on the local stack). */
  root: string
  log?: (line: string) => void
}

export interface StorageService {
  /** Handles one request whose URL has already been stripped of the `/storage/v1` prefix. */
  handle(req: IncomingMessage, res: ServerResponse, url: string): Promise<void>
  close(): Promise<void>
}

export declare function createStorageService(options: StorageServiceOptions): StorageService

export interface StorageEnvOptions {
  databaseUrl: string
  jwtSecret: string
  root: string
}

export declare function storageOptionsFromEnv(
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): StorageEnvOptions | null
