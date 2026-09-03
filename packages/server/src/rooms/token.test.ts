import { type MediaGrantDto, MEDIA_GRANT_TTL_SECONDS, RoomTokenDtoSchema } from '@earth/domain'
import { TokenVerifier } from 'livekit-server-sdk'
import { describe, expect, it } from 'vitest'

import { buildLiveKitToken, handleRoomToken, tokenMetadataFor, videoGrantFor } from './token'
import {
  FakeRpcFailure,
  TEST_LIVEKIT,
  TEST_NOW,
  createFakeDeps,
  fakeRequest,
  rpcFailure,
} from '../test/fakes'

const ROOM_ID = '22222222-2222-4222-8222-222222222222'
const HUMAN_ID = '11111111-1111-4111-8111-111111111111'
const GUEST_ID = '33333333-3333-4333-8333-333333333333'

function grant(overrides: Partial<MediaGrantDto> = {}): MediaGrantDto {
  return {
    livekitRoom: ROOM_ID,
    identity: `h:${HUMAN_ID}`,
    name: 'Xavier',
    role: 'participant',
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    ttlSeconds: MEDIA_GRANT_TTL_SECONDS,
    ...overrides,
  } as MediaGrantDto
}

const signer = {
  apiKey: TEST_LIVEKIT.apiKey,
  apiSecret: TEST_LIVEKIT.apiSecret,
  now: () => TEST_NOW,
}

/** Grant keys of the LiveKit VideoGrant that must never be true unless the grant says so. */
const FORBIDDEN_PERMISSIONS = [
  'roomAdmin',
  'roomCreate',
  'roomList',
  'roomRecord',
  'ingressAdmin',
  'canUpdateOwnMetadata',
  'hidden',
  'recorder',
  'agent',
] as const

describe('buildLiveKitToken', () => {
  const grants: [string, MediaGrantDto][] = [
    ['publisher', grant()],
    ['viewer', grant({ canPublish: false, role: 'viewer' })],
    ['guest on audio', grant({ identity: `g:${GUEST_ID}`, name: 'Sam', canPublish: true })],
    ['no data channel', grant({ canPublishData: false })],
    ['moderator', grant({ role: 'moderator' })],
  ]

  it.each(grants)('%s: claims never exceed the grant', async (_name, g) => {
    const built = await buildLiveKitToken(g, signer)
    const claims = await new TokenVerifier(TEST_LIVEKIT.apiKey, TEST_LIVEKIT.apiSecret).verify(
      built.token,
    )
    expect(claims.sub).toBe(g.identity)
    expect(claims.iss).toBe(TEST_LIVEKIT.apiKey)
    expect(claims.name).toBe(g.name)
    const video = claims.video ?? {}
    expect(video.room).toBe(g.livekitRoom)
    expect(video.roomJoin).toBe(true)
    expect(video.canPublish).toBe(g.canPublish)
    expect(video.canSubscribe).toBe(g.canSubscribe)
    expect(video.canPublishData).toBe(g.canPublishData)
    for (const key of FORBIDDEN_PERMISSIONS) expect(video[key]).not.toBe(true)
    expect(video.canPublishSources).toBeUndefined()
    expect(claims.sip).toBeUndefined()
    expect(claims.inference).toBeUndefined()
    expect(claims.observability).toBeUndefined()
    expect(claims.roomConfig).toBeUndefined()
    // TTL: exp is within the grant's ttl of the real clock (the SDK signs against Date.now()).
    const nowSeconds = Math.floor(Date.now() / 1000)
    expect(claims.exp).toBeGreaterThan(nowSeconds + g.ttlSeconds - 30)
    expect(claims.exp).toBeLessThanOrEqual(nowSeconds + g.ttlSeconds + 30)
    expect(JSON.parse(claims.metadata ?? '{}')).toEqual(tokenMetadataFor(g))
    expect(built.identity).toBe(g.identity)
    expect(built.expiresAt).toBe(new Date(TEST_NOW.getTime() + g.ttlSeconds * 1000).toISOString())
  })

  it('marks guests in the metadata and publishers by role', () => {
    expect(tokenMetadataFor(grant())).toEqual({ isGuest: false, role: 'participant' })
    expect(tokenMetadataFor(grant({ identity: `g:${GUEST_ID}`, role: 'viewer' }))).toEqual({
      isGuest: true,
      role: 'viewer',
    })
  })

  it('videoGrantFor spells every unrelated permission out as false', () => {
    const video = videoGrantFor(grant({ canPublish: false }))
    expect(video).toEqual({
      room: ROOM_ID,
      roomJoin: true,
      canPublish: false,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: false,
      roomAdmin: false,
      roomCreate: false,
      roomList: false,
      roomRecord: false,
      ingressAdmin: false,
      hidden: false,
      recorder: false,
      agent: false,
      canSubscribeMetrics: false,
      canManageAgentSession: false,
    })
  })

  it('rejects a malformed grant', async () => {
    await expect(
      buildLiveKitToken(
        grant({ identity: 'x:not-an-identity' as MediaGrantDto['identity'] }),
        signer,
      ),
    ).rejects.toThrow()
  })
})

describe('handleRoomToken', () => {
  it('requires a bearer token', async () => {
    const { deps, supabase } = createFakeDeps()
    const res = await handleRoomToken(
      deps,
      fakeRequest({ method: 'POST', url: `/api/rooms/${ROOM_ID}/token` }),
      ROOM_ID,
    ).catch((e: unknown) => e)
    expect(res).toMatchObject({ code: 'not_authenticated' })
    expect(supabase.calls).toHaveLength(0)
  })

  it('rejects a non-uuid room id before calling the database', async () => {
    const { deps, supabase } = createFakeDeps()
    const res = await handleRoomToken(
      deps,
      fakeRequest({ method: 'POST', url: '/api/rooms/x/token', bearer: 'tok' }),
      'x',
    ).catch((e: unknown) => e)
    expect(res).toMatchObject({ code: 'invalid_input' })
    expect(supabase.calls).toHaveLength(0)
  })

  it('calls room_media_grant as the caller and mints a token from the grant', async () => {
    const { deps, supabase } = createFakeDeps({
      rpc: { room_media_grant: () => grant({ canPublish: false, role: 'viewer' }) },
    })
    const res = await handleRoomToken(
      deps,
      fakeRequest({ method: 'POST', url: `/api/rooms/${ROOM_ID}/token`, bearer: 'user-jwt' }),
      ROOM_ID,
    )
    expect(res.status).toBe(200)
    expect(supabase.calls).toEqual([
      { client: 'user:user-jwt', name: 'room_media_grant', args: { room_id: ROOM_ID } },
    ])
    const dto = RoomTokenDtoSchema.parse(res.body)
    expect(dto.url).toBe(TEST_LIVEKIT.url)
    expect(dto.identity).toBe(`h:${HUMAN_ID}`)
    expect(dto.expiresAt).toBe(
      new Date(TEST_NOW.getTime() + MEDIA_GRANT_TTL_SECONDS * 1000).toISOString(),
    )
    const claims = await new TokenVerifier(TEST_LIVEKIT.apiKey, TEST_LIVEKIT.apiSecret).verify(
      dto.token,
    )
    expect(claims.video?.canPublish).toBe(false)
    expect(claims.video?.room).toBe(ROOM_ID)
  })

  it('surfaces database errors as EarthErrors (not_in_room, room_ended)', async () => {
    const { deps } = createFakeDeps({
      rpc: {
        room_media_grant: () => {
          throw rpcFailure('room_ended')
        },
      },
    })
    const err = await handleRoomToken(
      deps,
      fakeRequest({ method: 'POST', url: '/x', bearer: 't' }),
      ROOM_ID,
    ).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'room_ended' })
  })

  it('treats a grant that violates the DTO as internal (never mints from bad data)', async () => {
    const { deps } = createFakeDeps({
      rpc: { room_media_grant: () => ({ ...grant(), canPublish: 'yes' }) },
    })
    const err = await handleRoomToken(
      deps,
      fakeRequest({ method: 'POST', url: '/x', bearer: 't' }),
      ROOM_ID,
    ).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'internal' })
  })
})

describe('adversarial: token claims are bounded by the grant', () => {
  const verifier = new TokenVerifier(TEST_LIVEKIT.apiKey, TEST_LIVEKIT.apiSecret)
  /** The only video claims a grant may switch on. */
  const CARRIED_BY_GRANT = new Set([
    'room',
    'roomJoin',
    'canPublish',
    'canSubscribe',
    'canPublishData',
  ])

  it('every video claim the grant does not carry is present and false (no SDK default can widen it)', async () => {
    const built = await buildLiveKitToken(grant({ role: 'moderator' }), signer)
    const claims = await verifier.verify(built.token)
    const video = (claims.video ?? {}) as Record<string, unknown>
    for (const [key, value] of Object.entries(video)) {
      if (CARRIED_BY_GRANT.has(key)) continue
      expect(value, `video.${key}`).toBe(false)
    }
    // Fields added by livekit-server-sdk 2.18 must be spelled out too.
    expect(video['canSubscribeMetrics']).toBe(false)
    expect(video['canManageAgentSession']).toBe(false)
    expect(video['destinationRoom']).toBeUndefined()
    expect(claims.attributes).toBeUndefined()
    expect(claims.kind).toBeUndefined()
    expect(claims.roomPreset).toBeUndefined()
    expect(claims.sha256).toBeUndefined()
  })

  it('a moderator grant never becomes roomAdmin', async () => {
    const built = await buildLiveKitToken(grant({ role: 'moderator' }), signer)
    const claims = await verifier.verify(built.token)
    expect(claims.video?.roomAdmin).toBe(false)
    expect(claims.video?.room).toBe(ROOM_ID)
  })

  it('caps the TTL at MEDIA_GRANT_TTL_SECONDS even when the grant asks for more', async () => {
    const built = await buildLiveKitToken(
      grant({ ttlSeconds: MEDIA_GRANT_TTL_SECONDS * 24 }),
      signer,
    )
    const claims = await verifier.verify(built.token)
    const nowSeconds = Math.floor(Date.now() / 1000)
    expect(claims.exp).toBeLessThanOrEqual(nowSeconds + MEDIA_GRANT_TTL_SECONDS + 30)
    expect(built.expiresAt).toBe(
      new Date(TEST_NOW.getTime() + MEDIA_GRANT_TTL_SECONDS * 1000).toISOString(),
    )
  })

  it('a shorter grant TTL is honoured as is', async () => {
    const built = await buildLiveKitToken(grant({ ttlSeconds: 60 }), signer)
    const claims = await verifier.verify(built.token)
    const nowSeconds = Math.floor(Date.now() / 1000)
    expect(claims.exp).toBeLessThanOrEqual(nowSeconds + 60 + 30)
    expect(built.expiresAt).toBe(new Date(TEST_NOW.getTime() + 60_000).toISOString())
  })

  it('refuses to mint when the grant names a room other than the one requested', async () => {
    const OTHER_ROOM = '44444444-4444-4444-8444-444444444444'
    const { deps } = createFakeDeps({
      rpc: {
        room_media_grant: () => grant({ livekitRoom: OTHER_ROOM as MediaGrantDto['livekitRoom'] }),
      },
    })
    const err = await handleRoomToken(
      deps,
      fakeRequest({ method: 'POST', url: `/api/rooms/${ROOM_ID}/token`, bearer: 't' }),
      ROOM_ID,
    ).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'internal' })
    expect(JSON.stringify((err as { details?: unknown }).details ?? {})).not.toContain('token')
  })

  it('accepts an upper-case room id in the path (Postgres returns uuids lower-case)', async () => {
    const { deps } = createFakeDeps({ rpc: { room_media_grant: () => grant() } })
    const res = await handleRoomToken(
      deps,
      fakeRequest({ method: 'POST', url: '/x', bearer: 't' }),
      ROOM_ID.toUpperCase(),
    )
    expect(res.status).toBe(200)
    const claims = await verifier.verify(RoomTokenDtoSchema.parse(res.body).token)
    expect(claims.video?.room).toBe(ROOM_ID)
  })

  it('a request without a valid Supabase session never reaches LiveKit (expired JWT → 401)', async () => {
    const { deps } = createFakeDeps({
      rpc: {
        room_media_grant: () => {
          throw new FakeRpcFailure({ message: 'JWT expired', code: 'PGRST301' })
        },
      },
    })
    const err = await handleRoomToken(
      deps,
      fakeRequest({ method: 'POST', url: '/x', bearer: 'expired' }),
      ROOM_ID,
    ).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'not_authenticated' })
  })
})
