/**
 * Supabase Storage for the local stack (scripts/local-stack/gateway.mjs mounts it under
 * `/storage/v1`).
 *
 * Photo, video, file and voice messages, post media and claim avatars all go through
 * `supabase.storage.from(bucket).upload(...)` (packages/api `media.upload`). Without a Storage
 * service the local stack answered every one of those with 501, migration 0997 skipped its bucket
 * and policy setup, and that whole half of the messenger was never executed anywhere (audit DOD-02).
 *
 * This is the object subset the clients and the server tier use, over the filesystem:
 *
 *   POST   /object/:bucket/:key       upload            -> { Id, Key }
 *   PUT    /object/:bucket/:key       upload (upsert)   -> { Id, Key }
 *   POST   /object/sign/:bucket/:key  { expiresIn }     -> { signedURL }
 *   GET    /object/sign/:bucket/:key?token=...          -> the bytes
 *   GET    /object/public/:bucket/:key                  -> the bytes (public buckets only)
 *   GET    /object/:bucket/:key                         -> the bytes (owner only)
 *   DELETE /object/:bucket/:key                         -> { message: 'Successfully deleted' }
 *
 * Authorization is NOT reimplemented here: every request opens a transaction as the role its JWT
 * carries (exactly what PostgREST does), sets `request.jwt.claims`, and lets the `storage.objects`
 * policies migration 0997 installs decide. A refused insert is a real row level security refusal, so
 * the local stack proves the same rule production enforces — `(storage.foldername(name))[1] =
 * earth.current_human_id()`. Bytes are written only after the row is committed.
 *
 * Local only. Bytes live under `.local/storage/<bucket>/<key>`; nothing here is deployed.
 */
/* global Buffer, Response, URLSearchParams -- Node globals; the root ESLint config only declares them for .js/.cjs */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'

export const STORAGE_SERVICE_NAME = 'earth-local-storage'

/** Roles PostgREST (and this service) will switch to; anything else is refused. */
export const STORAGE_ROLES = Object.freeze(['anon', 'authenticated', 'service_role'])

/** Supabase's default when `createSignedUrl` is called without one; the api package always sends one. */
export const DEFAULT_SIGNED_URL_TTL_SECONDS = 3600

/** Largest upload accepted before the bucket's own `file_size_limit` is consulted. */
export const MAX_UPLOAD_BYTES = 104_857_600

const OBJECT_PREFIX = '/object'
const PERMISSION_DENIED = '42501'
const UNIQUE_VIOLATION = '23505'
const FOREIGN_KEY_VIOLATION = '23503'
const CHECK_VIOLATION = '23514'

const CORS_HEADERS = Object.freeze({
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': 'content-length, content-range, etag, x-upsert',
  'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
})

/** Storage's own error envelope, which @supabase/storage-js surfaces as `error.message`. */
class StorageHttpError extends Error {
  /** @param {number} status @param {string} error @param {string} message */
  constructor(status, error, message) {
    super(message)
    this.name = 'StorageHttpError'
    this.status = status
    this.error = error
  }
}

const notFound = (what = 'Object not found') => new StorageHttpError(404, 'not_found', what)
const unauthorized = (message) => new StorageHttpError(403, 'Unauthorized', message)

/** base64url without padding, as JWTs use. */
const b64url = (buffer) => Buffer.from(buffer).toString('base64url')

/** @param {string} secret @param {string} signingInput */
const sign = (secret, signingInput) =>
  createHmac('sha256', secret).update(signingInput).digest('base64url')

/**
 * Verifies a compact HS256 JWS and returns its claims, or null when the token is malformed, signed
 * with another secret or expired. Mirrors scripts/local-stack/jwt.ts `verifyJwt` (TypeScript, so it
 * cannot be imported by a file `node` runs directly).
 * @param {string} token @param {string} secret
 */
export function verifyToken(token, secret) {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, payload, signature] = parts
  const expected = Buffer.from(sign(secret, `${header}.${payload}`))
  const actual = Buffer.from(signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  let claims
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof claims !== 'object' || claims === null) return null
  if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) return null
  return claims
}

/** Mints the compact HS256 JWS a signed object URL carries (`{ url, exp }`, as storage-api does). */
export function mintSignedToken(secret, url, expiresInSeconds, now = Date.now()) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(
    JSON.stringify({ url, exp: Math.floor(now / 1000) + Math.max(1, expiresInSeconds) }),
  )
  return `${header}.${payload}.${sign(secret, `${header}.${payload}`)}`
}

/**
 * Classifies a path already stripped of `/storage/v1`. Pure, so the routing is unit-tested without
 * sockets or a database.
 * @param {string} method @param {string} url
 * @returns {{ kind: string, bucket?: string, key?: string, query?: URLSearchParams }}
 */
export function resolveObjectRoute(method, url) {
  const queryIndex = url.indexOf('?')
  const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex)
  const query = new URLSearchParams(queryIndex === -1 ? '' : url.slice(queryIndex + 1))
  if (!pathname.startsWith(`${OBJECT_PREFIX}/`)) return { kind: 'not_found' }

  const segments = pathname
    .slice(OBJECT_PREFIX.length + 1)
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
  const mode = segments[0] === 'sign' || segments[0] === 'public' ? segments.shift() : null
  const bucket = segments.shift()
  const key = segments.join('/')
  if (bucket === undefined || bucket === '' || key === '') return { kind: 'not_found' }
  // `..` or an absolute segment would escape the bucket directory on disk.
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return { kind: 'invalid_key' }
  }

  if (mode === 'sign') {
    if (method === 'POST') return { kind: 'create_signed_url', bucket, key, query }
    if (method === 'GET') return { kind: 'download_signed', bucket, key, query }
    return { kind: 'not_found' }
  }
  if (mode === 'public') {
    return method === 'GET'
      ? { kind: 'download_public', bucket, key, query }
      : { kind: 'not_found' }
  }
  if (method === 'POST' || method === 'PUT') return { kind: 'upload', bucket, key, query }
  if (method === 'GET') return { kind: 'download', bucket, key, query }
  if (method === 'DELETE') return { kind: 'remove', bucket, key, query }
  return { kind: 'not_found' }
}

/** @param {import('node:http').IncomingMessage} req */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_UPLOAD_BYTES) {
        reject(new StorageHttpError(413, 'Payload too large', 'The object exceeded the size limit'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * The uploaded bytes and their content type. Browsers send `multipart/form-data` (storage-js wraps a
 * Blob in FormData); Node callers send the raw body with a `content-type` header.
 * @param {Buffer} body @param {string} contentType
 */
export async function parseUploadBody(body, contentType) {
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return {
      bytes: body,
      contentType: contentType === '' ? 'application/octet-stream' : contentType,
    }
  }
  const form = await new Response(body, { headers: { 'content-type': contentType } }).formData()
  for (const value of form.values()) {
    if (typeof value === 'string') continue
    return {
      bytes: Buffer.from(await value.arrayBuffer()),
      contentType: value.type === '' ? 'application/octet-stream' : value.type,
    }
  }
  throw new StorageHttpError(400, 'InvalidRequest', 'No file was uploaded in the form data')
}

/** The bearer a supabase-js request carries: the session token, else the apikey. */
export function bearerOf(headers) {
  const authorization = headers['authorization']
  if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice('bearer '.length).trim()
  }
  const apikey = headers['apikey']
  return typeof apikey === 'string' && apikey !== '' ? apikey : null
}

/**
 * A Storage service over `pool`, the filesystem and the 0997 policies.
 * @param {{ pool?: pg.Pool, databaseUrl?: string, jwtSecret: string, root: string, log?: (line: string) => void }} options
 */
export function createStorageService(options) {
  const pool =
    options.pool ?? new pg.Pool({ connectionString: options.databaseUrl, max: 4, min: 0 })
  const ownsPool = options.pool === undefined
  const log = options.log ?? (() => undefined)
  const root = options.root

  /** Runs `fn` in one transaction as the caller the JWT stands for (PostgREST's own impersonation). */
  async function asCaller(claims, fn) {
    const client = await pool.connect()
    try {
      await client.query('begin')
      try {
        await client.query(`set local role ${claims.role}`)
        await client.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify(claims),
        ])
        const result = await fn(client)
        await client.query('commit')
        return result
      } catch (error) {
        await client.query('rollback').catch(() => undefined)
        throw error
      }
    } finally {
      client.release()
    }
  }

  /**
   * Runs `fn` as `service_role`, which is the role storage-api itself holds. The pool connects as
   * `authenticator` (PostgREST's role, `noinherit`), so a statement outside a `set role` has no
   * privileges at all — every read that must see past RLS goes through here.
   */
  const asService = (fn) => asCaller({ role: 'service_role' }, fn)

  /** Bucket configuration, read past RLS the way storage-api does (it holds the service role). */
  async function bucketConfig(id) {
    return asService(async (client) => {
      const { rows } = await client.query(
        `select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = $1`,
        [id],
      )
      return rows[0] ?? null
    })
  }

  /** The stored object row regardless of who is asking (a signed URL and a public bucket bypass RLS). */
  async function objectRow(bucket, key) {
    return asService(async (client) => {
      const { rows } = await client.query(
        `select id, metadata from storage.objects where bucket_id = $1 and name = $2`,
        [bucket, key],
      )
      return rows[0] ?? null
    })
  }

  const filePath = (bucket, key) => path.join(root, bucket, key)

  /** @param {Record<string, string | string[] | undefined>} headers */
  function claimsFrom(headers) {
    const token = bearerOf(headers)
    if (token === null) throw unauthorized('No authorization header')
    const claims = verifyToken(token, options.jwtSecret)
    if (claims === null) throw unauthorized('Invalid JWT')
    const role = typeof claims.role === 'string' ? claims.role : ''
    if (!STORAGE_ROLES.includes(role)) throw unauthorized(`Unsupported role: ${role || 'none'}`)
    return { ...claims, role }
  }

  /** Turns a Postgres refusal into Storage's own status codes. */
  function asHttpError(error, bucket) {
    if (error instanceof StorageHttpError) return error
    if (error instanceof pg.DatabaseError) {
      if (error.code === PERMISSION_DENIED) {
        return unauthorized('new row violates row-level security policy')
      }
      if (error.code === UNIQUE_VIOLATION) {
        return new StorageHttpError(409, 'Duplicate', 'The resource already exists')
      }
      if (error.code === FOREIGN_KEY_VIOLATION) {
        return new StorageHttpError(404, 'Bucket not found', `Bucket not found: ${bucket}`)
      }
      if (error.code === CHECK_VIOLATION) {
        return new StorageHttpError(400, 'InvalidRequest', error.message)
      }
    }
    return new StorageHttpError(500, 'Internal', error instanceof Error ? error.message : 'failed')
  }

  async function upload(req, route, claims) {
    const bucket = await bucketConfig(route.bucket)
    if (bucket === null) {
      throw new StorageHttpError(404, 'Bucket not found', `Bucket not found: ${route.bucket}`)
    }
    const body = await readBody(req)
    const payload = await parseUploadBody(body, String(req.headers['content-type'] ?? ''))
    const limit =
      bucket.file_size_limit === null ? MAX_UPLOAD_BYTES : Number(bucket.file_size_limit)
    if (payload.bytes.length > limit) {
      throw new StorageHttpError(413, 'Payload too large', `The object exceeded ${limit} bytes`)
    }
    const mimes = bucket.allowed_mime_types
    const mime = payload.contentType.split(';')[0]?.trim() ?? ''
    if (Array.isArray(mimes) && mimes.length > 0 && !mimes.includes(mime)) {
      throw new StorageHttpError(415, 'invalid_mime_type', `mime type ${mime} is not supported`)
    }
    const upsert = req.method === 'PUT' || req.headers['x-upsert'] === 'true'

    // The row first: when the policies refuse it, no byte is written.
    const id = await asCaller(claims, async (client) => {
      const metadata = {
        mimetype: payload.contentType,
        size: payload.bytes.length,
        cacheControl: String(req.headers['cache-control'] ?? 'max-age=3600'),
      }
      const owner = typeof claims.sub === 'string' ? claims.sub : null
      const { rows } = await client.query(
        upsert
          ? `insert into storage.objects (bucket_id, name, owner, owner_id, metadata, version)
             values ($1, $2, $3::uuid, $3::text, $4::jsonb, $5)
             on conflict (bucket_id, name) do update
               set metadata = excluded.metadata, updated_at = now(), version = excluded.version
             returning id`
          : `insert into storage.objects (bucket_id, name, owner, owner_id, metadata, version)
             values ($1, $2, $3::uuid, $3::text, $4::jsonb, $5) returning id`,
        [route.bucket, route.key, owner, JSON.stringify(metadata), randomUUID()],
      )
      const inserted = rows[0]?.id
      // `on conflict do update` returns nothing when the update policy hides the existing row.
      if (inserted === undefined) throw unauthorized('new row violates row-level security policy')
      return inserted
    })

    const target = filePath(route.bucket, route.key)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, payload.bytes)
    log(`stored ${route.bucket}/${route.key} (${payload.bytes.length} bytes)`)
    return { status: 200, body: { Id: id, Key: `${route.bucket}/${route.key}` } }
  }

  /** The object row as the caller may read it (0997's select policies), or null. */
  async function readableObject(claims, bucket, key) {
    return asCaller(claims, async (client) => {
      const { rows } = await client.query(
        `select id, metadata from storage.objects where bucket_id = $1 and name = $2`,
        [bucket, key],
      )
      return rows[0] ?? null
    })
  }

  async function createSignedUrl(req, route, claims) {
    const raw = await readBody(req)
    let expiresIn = DEFAULT_SIGNED_URL_TTL_SECONDS
    if (raw.length > 0) {
      try {
        const parsed = JSON.parse(raw.toString('utf8'))
        if (typeof parsed?.expiresIn === 'number') expiresIn = parsed.expiresIn
      } catch {
        throw new StorageHttpError(400, 'InvalidRequest', 'Body must be JSON')
      }
    }
    const object = await readableObject(claims, route.bucket, route.key)
    if (object === null) throw notFound()
    const url = `${route.bucket}/${route.key}`
    const token = mintSignedToken(options.jwtSecret, url, expiresIn)
    return {
      status: 200,
      body: { signedURL: `${OBJECT_PREFIX}/sign/${url}?token=${token}` },
    }
  }

  /** Streams the stored bytes; the row decides the content type, as storage-api's metadata does. */
  async function streamObject(res, bucket, key, metadata) {
    const target = filePath(bucket, key)
    let size
    try {
      size = (await stat(target)).size
    } catch {
      throw notFound()
    }
    const mimetype =
      typeof metadata?.mimetype === 'string' ? metadata.mimetype : 'application/octet-stream'
    res.writeHead(200, {
      ...CORS_HEADERS,
      'content-type': mimetype,
      'content-length': size,
      'cache-control': 'no-store',
    })
    const bytes = createReadStream(target)
    // The status line is already out, so a read failure can only end the response early.
    bytes.on('error', (error) => {
      log(`read failed for ${bucket}/${key}: ${error.message}`)
      res.destroy()
    })
    bytes.pipe(res)
  }

  async function handle(req, res, url) {
    const method = req.method ?? 'GET'
    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS)
      res.end()
      return
    }
    const route = resolveObjectRoute(method, url)
    try {
      if (route.kind === 'not_found') throw notFound('Not found')
      if (route.kind === 'invalid_key') {
        throw new StorageHttpError(400, 'InvalidKey', `Invalid key: ${url}`)
      }

      if (route.kind === 'download_signed') {
        const token = route.query.get('token') ?? ''
        const claims = verifyToken(token, options.jwtSecret)
        if (claims === null || claims.url !== `${route.bucket}/${route.key}`) {
          throw unauthorized('Invalid or expired signed URL')
        }
        const signed = await objectRow(route.bucket, route.key)
        if (signed === null) throw notFound()
        await streamObject(res, route.bucket, route.key, signed.metadata)
        return
      }

      if (route.kind === 'download_public') {
        const bucket = await bucketConfig(route.bucket)
        if (bucket === null || bucket.public !== true) throw notFound()
        const object = await objectRow(route.bucket, route.key)
        if (object === null) throw notFound()
        await streamObject(res, route.bucket, route.key, object.metadata)
        return
      }

      const claims = claimsFrom(req.headers)
      if (route.kind === 'upload') {
        const result = await upload(req, route, claims)
        sendJson(res, result.status, result.body)
        return
      }
      if (route.kind === 'create_signed_url') {
        const result = await createSignedUrl(req, route, claims)
        sendJson(res, result.status, result.body)
        return
      }
      if (route.kind === 'download') {
        const object = await readableObject(claims, route.bucket, route.key)
        if (object === null) throw notFound()
        await streamObject(res, route.bucket, route.key, object.metadata)
        return
      }
      // remove
      const deleted = await asCaller(claims, async (client) => {
        const { rowCount } = await client.query(
          `delete from storage.objects where bucket_id = $1 and name = $2`,
          [route.bucket, route.key],
        )
        return rowCount ?? 0
      })
      if (deleted === 0) throw notFound()
      await rm(filePath(route.bucket, route.key), { force: true })
      sendJson(res, 200, { message: 'Successfully deleted' })
    } catch (error) {
      const http = asHttpError(error, route.bucket ?? '')
      if (http.status >= 500) log(`error on ${method} ${url}: ${http.message}`)
      sendJson(res, http.status, {
        statusCode: String(http.status),
        error: http.error,
        message: http.message,
      })
    }
  }

  return {
    handle,
    close: async () => {
      if (ownsPool) await pool.end()
    },
  }
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
function sendJson(res, status, body) {
  if (res.headersSent) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    ...CORS_HEADERS,
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Storage options from the stack environment, or `null` when the stack has no database URL or JWT
 * secret to give it — the gateway then keeps answering `/storage/v1` with 501, as before.
 * @param {NodeJS.ProcessEnv} env @param {string} repoRoot
 */
export function storageOptionsFromEnv(env, repoRoot) {
  // The `authenticator` role, which is exactly what PostgREST connects as and can `set role`.
  const databaseUrl = env['EARTH_STORAGE_DB_URI'] ?? env['PGRST_DB_URI']
  const jwtSecret = env['SUPABASE_JWT_SECRET'] ?? env['EARTH_JWT_SECRET']
  if (
    databaseUrl === undefined ||
    databaseUrl === '' ||
    jwtSecret === undefined ||
    jwtSecret === ''
  ) {
    return null
  }
  return {
    databaseUrl,
    jwtSecret,
    root: env['EARTH_STORAGE_DIR'] ?? path.join(repoRoot, '.local', 'storage'),
  }
}
