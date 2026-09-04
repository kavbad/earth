/**
 * The local Storage service (scripts/local-stack/storage.mjs) end to end: a real
 * `@supabase/storage-js` client, over a real socket, through the gateway, against a freshly migrated
 * database — the same library and the same wire calls `packages/api` `media.upload` and
 * `media.signedUrl` make for every photo, video, file, voice note and claim avatar.
 *
 * Before this existed the stack answered `/storage/v1` with 501 and migration 0997 skipped its own
 * bucket and policy setup, so nothing anywhere ever uploaded a byte or evaluated a `storage.objects`
 * policy (audit DOD-02). What is asserted here is therefore not the emulator but the rule: the first
 * path segment of an object key must be the caller's own Human, and it is Postgres row level
 * security — not this service — that decides it.
 *
 * `@supabase/storage-js` is the storage half of `@supabase/supabase-js`, which `packages/api`
 * depends on; `.npmrc` pins `node-linker=hoisted`, so it resolves from the repository root.
 */
import { StorageClient } from '@supabase/storage-js'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DEFAULT_DATABASE_URL,
  adminDatabaseUrl,
  quoteIdentifier,
  resetDatabase,
} from '../db/migrate-core'
import { DATABASE_SEARCH_PATH, migrateDatabase, setDatabaseSearchPath } from '../db/migrate-lib'
import { PREFIXES, startGateway, type RunningGateway } from './gateway.mjs'
import { AUTHENTICATED_AUDIENCE, AUTHENTICATED_ROLE, mintJwt } from './jwt'
import { createStorageService, resolveObjectRoute } from './storage.mjs'

const JWT_SECRET = 'earth-local-storage-test-secret-000000000'
const ADMIN_URL = process.env['DATABASE_URL'] ?? DEFAULT_DATABASE_URL
/** The role the shim gives PostgREST, which the Storage service also connects as. */
const AUTHENTICATOR = { user: 'authenticator', password: 'postgres' }

const JPEG = Buffer.from('\xff\xd8\xff\xe0 earth test photo bytes', 'binary')
const VOICE = Buffer.from('earth test voice note bytes')

interface Person {
  userId: string
  humanId: string
  token: string
}

function storageFor(baseUrl: string, token: string): StorageClient {
  return new StorageClient(`${baseUrl}${PREFIXES.storage}`, {
    apikey: token,
    Authorization: `Bearer ${token}`,
  })
}

describe('local Storage service (0997 buckets and object policies over HTTP)', () => {
  const database = `earth_storage_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  let admin: pg.Client
  let sql: pg.Client
  let gateway: RunningGateway
  let root: string
  let base: string
  let alice: Person
  let bob: Person
  let anonToken: string
  let serviceToken: string

  /** An auth user plus an active Human, and the session JWT GoTrue would mint for it. */
  async function person(handle: string): Promise<Person> {
    const userId = randomUUID()
    await sql.query(
      `insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at)
       values ($1, 'authenticated', 'authenticated', $2, now(), now(), now())`,
      [userId, `${handle}@example.test`],
    )
    const { rows } = await sql.query<{ id: string }>(
      `insert into public.humans (status, human_pass_status, auth_user_id, claimed_at, last_active_at)
       values ('active', 'verified', $1, now(), now()) returning id`,
      [userId],
    )
    const humanId = rows[0]?.id
    if (humanId === undefined) throw new Error('humans insert returned no id')
    await sql.query(
      `insert into public.public_identities (human_id, display_name, handle, profile_visibility)
       values ($1, $2, $3, 'public')`,
      [humanId, handle, handle],
    )
    return {
      userId,
      humanId,
      token: mintJwt(
        {
          sub: userId,
          role: AUTHENTICATED_ROLE,
          aud: AUTHENTICATED_AUDIENCE,
          exp: Math.floor(Date.now() / 1000) + 3600,
        },
        JWT_SECRET,
      ),
    }
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminDatabaseUrl(ADMIN_URL) })
    await admin.connect()
    await resetDatabase(admin, database)
    await setDatabaseSearchPath(admin, database)

    const url = `${adminDatabaseUrl(ADMIN_URL).replace(/\/[^/]*$/, '')}/${database}`
    sql = new pg.Client({ connectionString: url })
    await sql.connect()
    await sql.query(`set search_path to ${DATABASE_SEARCH_PATH}`)
    await migrateDatabase(sql, { info: () => undefined })

    alice = await person('alice')
    bob = await person('bob')
    anonToken = mintJwt({ role: 'anon', exp: Math.floor(Date.now() / 1000) + 3600 }, JWT_SECRET)
    serviceToken = mintJwt(
      { role: 'service_role', exp: Math.floor(Date.now() / 1000) + 3600 },
      JWT_SECRET,
    )

    root = await mkdtemp(path.join(os.tmpdir(), 'earth-storage-'))
    const parsed = new URL(url)
    parsed.username = AUTHENTICATOR.user
    parsed.password = AUTHENTICATOR.password
    gateway = await startGateway({
      port: 0,
      upstreams: { rest: { host: '127.0.0.1', port: 1 }, auth: { host: '127.0.0.1', port: 1 } },
      storage: createStorageService({
        databaseUrl: parsed.toString(),
        jwtSecret: JWT_SECRET,
        root,
      }),
      log: () => undefined,
    })
    base = `http://127.0.0.1:${gateway.port}`
  }, 120_000)

  afterAll(async () => {
    await gateway?.close()
    await rm(root, { recursive: true, force: true })
    await sql?.end()
    if (admin !== undefined) {
      await admin.query(`drop database if exists ${quoteIdentifier(database)} with (force)`)
      await admin.end()
    }
  })

  it('stores the bytes of a photo message under the sender’s own human id', async () => {
    const key = `${alice.humanId}/${randomUUID()}.jpg`
    const { data, error } = await storageFor(base, alice.token)
      .from('media')
      .upload(key, JPEG, { contentType: 'image/jpeg', upsert: false })

    expect(error).toBeNull()
    expect(data?.path).toBe(key)
    expect(data?.fullPath).toBe(`media/${key}`)
    // The bytes really landed on disk, and the row the policies gate really exists.
    expect(await readFile(path.join(root, 'media', key))).toEqual(JPEG)
    const { rows } = await sql.query<{ mimetype: string; size: number }>(
      `select metadata->>'mimetype' as mimetype, (metadata->>'size')::int as size
         from storage.objects where bucket_id = 'media' and name = $1`,
      [key],
    )
    expect(rows[0]).toEqual({ mimetype: 'image/jpeg', size: JPEG.length })
  })

  it('stores a voice note sent the way a browser sends one (multipart Blob)', async () => {
    const key = `${alice.humanId}/${randomUUID()}.m4a`
    const blob = new Blob([VOICE], { type: 'audio/mp4' })
    const { data, error } = await storageFor(base, alice.token).from('voice').upload(key, blob)

    expect(error).toBeNull()
    expect(data?.path).toBe(key)
    expect(await readFile(path.join(root, 'voice', key))).toEqual(VOICE)
  })

  it('refuses an upload into another member’s folder, and writes nothing', async () => {
    const key = `${bob.humanId}/${randomUUID()}.jpg`
    const { data, error } = await storageFor(base, alice.token)
      .from('media')
      .upload(key, JPEG, { contentType: 'image/jpeg' })

    expect(data).toBeNull()
    expect(error?.message).toContain('row-level security')
    await expect(readFile(path.join(root, 'media', key))).rejects.toThrow()
    const { rowCount } = await sql.query(`select 1 from storage.objects where name = $1`, [key])
    expect(rowCount).toBe(0)
  })

  it('refuses a caller with no Human and a caller with no credential at all', async () => {
    const key = `${alice.humanId}/${randomUUID()}.jpg`
    const asVisitor = await storageFor(base, anonToken)
      .from('media')
      .upload(key, JPEG, { contentType: 'image/jpeg' })
    expect(asVisitor.error).not.toBeNull()

    const unsigned = await fetch(`${base}${PREFIXES.storage}/object/media/${key}`, {
      method: 'POST',
      headers: { 'content-type': 'image/jpeg' },
      body: JPEG,
    })
    expect(unsigned.status).toBe(403)
    await expect(unsigned.json()).resolves.toMatchObject({ error: 'Unauthorized' })
  })

  it('signs a private object for its owner and for the server tier, and for nobody else', async () => {
    const key = `${alice.humanId}/${randomUUID()}.jpg`
    await storageFor(base, alice.token)
      .from('media')
      .upload(key, JPEG, { contentType: 'image/jpeg' })

    const signed = await storageFor(base, alice.token).from('media').createSignedUrl(key, 60)
    expect(signed.error).toBeNull()
    const url = signed.data?.signedUrl ?? ''
    expect(url).toContain(`/object/sign/media/${key}?token=`)

    // The signed URL is the thing an <img> or <audio> element fetches: no session, just the token.
    const fetched = await fetch(url)
    expect(fetched.status).toBe(200)
    expect(fetched.headers.get('content-type')).toBe('image/jpeg')
    expect(Buffer.from(await fetched.arrayBuffer())).toEqual(JPEG)
    expect((await fetch(`${url.split('?')[0] ?? ''}?token=forged`)).status).toBe(403)

    // packages/server signs with the service role after its own audience check (spec §104).
    const asService = await storageFor(base, serviceToken).from('media').createSignedUrl(key, 60)
    expect(asService.error).toBeNull()

    // Another member cannot even see the row, so there is nothing to sign and nothing to download.
    const asBob = await storageFor(base, bob.token).from('media').createSignedUrl(key, 60)
    expect(asBob.data).toBeNull()
    expect(
      (
        await fetch(`${base}${PREFIXES.storage}/object/media/${key}`, {
          headers: { Authorization: `Bearer ${bob.token}` },
        })
      ).status,
    ).toBe(404)
  })

  it('serves an avatar from the public bucket to anyone, with no credential', async () => {
    const key = `${alice.humanId}/${randomUUID()}.jpg`
    const uploaded = await storageFor(base, alice.token)
      .from('avatars')
      .upload(key, JPEG, { contentType: 'image/jpeg' })
    expect(uploaded.error).toBeNull()

    const publicUrl = storageFor(base, alice.token).from('avatars').getPublicUrl(key).data.publicUrl
    expect(publicUrl).toBe(`${base}${PREFIXES.storage}/object/public/avatars/${key}`)
    const fetched = await fetch(publicUrl)
    expect(fetched.status).toBe(200)
    expect(Buffer.from(await fetched.arrayBuffer())).toEqual(JPEG)

    // A private bucket is never public, whoever asks.
    const privateKey = `${alice.humanId}/${randomUUID()}.jpg`
    await storageFor(base, alice.token)
      .from('media')
      .upload(privateKey, JPEG, { contentType: 'image/jpeg' })
    expect(
      (await fetch(`${base}${PREFIXES.storage}/object/public/media/${privateKey}`)).status,
    ).toBe(404)
  })

  it('enforces the bucket’s mime types', async () => {
    const rejected = await storageFor(base, alice.token)
      .from('voice')
      .upload(`${alice.humanId}/${randomUUID()}.exe`, Buffer.from('nope'), {
        contentType: 'application/x-msdownload',
      })
    expect(rejected.error?.message).toContain('mime type')
  })
})

describe('resolveObjectRoute', () => {
  it('classifies the calls storage-js makes', () => {
    expect(resolveObjectRoute('POST', '/object/media/h/a.jpg')).toMatchObject({
      kind: 'upload',
      bucket: 'media',
      key: 'h/a.jpg',
    })
    expect(resolveObjectRoute('PUT', '/object/media/h/a.jpg')).toMatchObject({ kind: 'upload' })
    expect(resolveObjectRoute('POST', '/object/sign/media/h/a.jpg')).toMatchObject({
      kind: 'create_signed_url',
    })
    expect(resolveObjectRoute('GET', '/object/sign/media/h/a.jpg?token=x')).toMatchObject({
      kind: 'download_signed',
    })
    expect(resolveObjectRoute('GET', '/object/public/avatars/h/a.jpg')).toMatchObject({
      kind: 'download_public',
    })
    expect(resolveObjectRoute('GET', '/object/media/h/a.jpg')).toMatchObject({ kind: 'download' })
    expect(resolveObjectRoute('DELETE', '/object/media/h/a.jpg')).toMatchObject({ kind: 'remove' })
  })

  it('refuses a key that would escape its bucket directory', () => {
    // A URL normaliser resolves `..` before it ever reaches the service; the encoded forms do not.
    for (const key of ['h/../../escape.jpg', 'h/%2e%2e/escape.jpg', 'h//escape.jpg', 'h/./a.jpg']) {
      expect(resolveObjectRoute('POST', `/object/media/${key}`).kind, key).toBe('invalid_key')
    }
    expect(resolveObjectRoute('GET', '/bucket/list').kind).toBe('not_found')
    expect(resolveObjectRoute('POST', '/object/media').kind).toBe('not_found')
  })
})
