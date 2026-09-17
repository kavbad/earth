/**
 * `GET /api/media/:bucket/:key*` (spec §104): the database authorizes the caller, the service role
 * signs, the route redirects. Nothing is signed that `media_access_grant` did not hand back.
 */
import { describe, expect, it } from 'vitest'

import { isErrorBody } from '../http'
import { ROUTES, createEarthServer, matchRoute } from '../router'
import { FAKE_STORAGE_ORIGIN, createFakeDeps, fakeRequest, rpcFailure } from '../test/fakes'
import {
  MEDIA_ACCESS_GRANT_RPC,
  MEDIA_CACHE_CONTROL,
  MEDIA_SIGNED_URL_SECONDS,
  handleMediaSigned,
} from './signed'

const MEDIA_ID = '33333333-3333-4333-8333-333333333333'
const OWNER = '11111111-1111-4111-8111-111111111111'
const KEY = `${OWNER}/photo.jpg`
const GRANT = {
  mediaObjectId: MEDIA_ID,
  bucket: 'media',
  storageKey: KEY,
  contentType: 'image/jpeg',
  isPublic: false,
}

function depsThatGrant(grant: unknown = GRANT) {
  return createFakeDeps({ rpc: { [MEDIA_ACCESS_GRANT_RPC]: () => grant } })
}

function codeOf(body: unknown): string | undefined {
  return isErrorBody(body) ? body.error.code : undefined
}

describe('GET /api/media/:bucket/:key*', () => {
  it('signs with the service role and redirects', async () => {
    const { deps, storage, supabase } = depsThatGrant()
    const res = await handleMediaSigned(
      deps,
      fakeRequest({ url: '/x', bearer: 'viewer' }),
      'media',
      KEY,
    )

    expect(res.status).toBe(302)
    expect(res.headers['location']).toBe(
      `${FAKE_STORAGE_ORIGIN}/object/sign/media/${KEY}?token=t-${MEDIA_SIGNED_URL_SECONDS}`,
    )
    expect(res.headers['cache-control']).toBe(MEDIA_CACHE_CONTROL)
    expect(res.body).toBeUndefined()
    expect(storage.calls).toEqual([
      { bucket: 'media', path: KEY, expiresIn: MEDIA_SIGNED_URL_SECONDS },
    ])
    // Authorization runs as the caller, with the key the route parsed out of the path.
    expect(supabase.callsTo(MEDIA_ACCESS_GRANT_RPC)).toEqual([
      {
        client: 'user:viewer',
        name: MEDIA_ACCESS_GRANT_RPC,
        args: { bucket: 'media', storage_key: KEY },
      },
    ])
  })

  it('reads as a Visitor without a bearer', async () => {
    const { deps, supabase } = depsThatGrant()
    const res = await handleMediaSigned(deps, fakeRequest({ url: '/x' }), 'media', KEY)

    expect(res.status).toBe(302)
    expect(supabase.callsTo(MEDIA_ACCESS_GRANT_RPC)[0]?.client).toBe('anon')
  })

  it('answers 403 when the database refuses, and never signs', async () => {
    const { deps, storage } = createFakeDeps({
      rpc: {
        [MEDIA_ACCESS_GRANT_RPC]: () => {
          throw rpcFailure('forbidden')
        },
      },
    })
    const res = await createEarthServer(deps).handle(
      fakeRequest({ url: `/api/media/media/${KEY}`, bearer: 'stranger' }),
    )

    expect(res.status).toBe(403)
    expect(codeOf(res.body)).toBe('forbidden')
    expect(storage.calls).toEqual([])
  })

  it('refuses an unknown bucket before asking the database', async () => {
    const { deps, supabase } = depsThatGrant()
    const server = createEarthServer(deps)
    const res = await server.handle(fakeRequest({ url: `/api/media/secrets/${KEY}` }))

    expect(res.status).toBe(403)
    expect(codeOf(res.body)).toBe('forbidden')
    expect(supabase.calls).toEqual([])
  })

  it('is internal (never a redirect) when Storage is not configured or signing fails', async () => {
    const noStorage = createFakeDeps({
      rpc: { [MEDIA_ACCESS_GRANT_RPC]: () => GRANT },
      storage: false,
    })
    const unavailable = await createEarthServer(noStorage.deps).handle(
      fakeRequest({ url: `/api/media/media/${KEY}` }),
    )
    expect(unavailable.status).toBe(500)
    expect(codeOf(unavailable.body)).toBe('internal')

    const broken = depsThatGrant()
    broken.storage.signFor = () => ({ data: null, error: { message: 'object not found' } })
    const failed = await createEarthServer(broken.deps).handle(
      fakeRequest({ url: `/api/media/media/${KEY}` }),
    )
    expect(failed.status).toBe(500)
    expect(codeOf(failed.body)).toBe('internal')
    // The vendor message never reaches the caller.
    expect(JSON.stringify(failed.body)).not.toContain('object not found')
  })

  it('routes a multi-segment storage key through the router', async () => {
    const key = `${OWNER}/2026/09/clip.mp4`
    const { deps, storage } = depsThatGrant({ ...GRANT, bucket: 'voice', storageKey: key })
    const server = createEarthServer(deps)
    const res = await server.handle(fakeRequest({ url: `/api/media/voice/${key}?w=800` }))

    expect(res.status).toBe(302)
    expect(storage.calls[0]).toEqual({
      bucket: 'voice',
      path: key,
      expiresIn: MEDIA_SIGNED_URL_SECONDS,
    })
    const match = matchRoute(ROUTES, 'GET', `/api/media/voice/${key}`)
    expect(match.kind === 'matched' && match.route.name).toBe('media.signed')
    expect(match.kind === 'matched' && match.params).toEqual({ bucket: 'voice', key })
  })

  it('does not match the bucket alone', async () => {
    expect(matchRoute(ROUTES, 'GET', '/api/media/media').kind).toBe('not_found')
    expect(matchRoute(ROUTES, 'POST', `/api/media/media/${KEY}`)).toEqual({
      kind: 'method_not_allowed',
      allowed: ['GET'],
    })
  })
})
