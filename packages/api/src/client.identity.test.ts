import { FEATURE_FLAG_DEFAULTS } from '@earth/config'
import { describe, expect, it } from 'vitest'

import { featureFlagsFromDto, extensionForContentType } from './namespaces/identity'
import { RPC, SERVER_ROUTES, TABLES } from './rpc'
import { earthRejection } from './testing/expect'
import * as fixtures from './testing/fixtures'
import { createTestClient } from './testing/harness'
import { postgrestRaise } from './testing/fake-supabase'

const { IDS, AT } = fixtures

describe('flags', () => {
  it('reads feature_flags and keys the DTO by flag', async () => {
    const { client, supabase } = createTestClient()
    supabase.onQuery(TABLES.featureFlags, {
      data: [
        fixtures.featureFlagRow(),
        fixtures.featureFlagRow({
          key: 'MAFIA_ACTIVITY_ENABLED',
          enabled: false,
          payload: { note: 'x' },
        }),
      ],
    })
    const flags = await client.flags.get()
    expect(supabase.lastQuery()).toMatchObject({
      table: 'feature_flags',
      kind: 'select',
      columns: 'key, enabled, payload, updated_at',
    })
    expect(flags['PUBLIC_WORLD_ENABLED']).toEqual({ enabled: true, payload: null, updatedAt: AT })
    expect(flags['MAFIA_ACTIVITY_ENABLED']?.payload).toEqual({ note: 'x' })
  })

  it('resolved() merges rows over the launch defaults', async () => {
    const { client, supabase } = createTestClient()
    supabase.onQuery(TABLES.featureFlags, {
      data: [fixtures.featureFlagRow({ key: 'MAFIA_ACTIVITY_ENABLED', enabled: true })],
    })
    const resolved = await client.flags.resolved()
    expect(resolved.MAFIA_ACTIVITY_ENABLED).toBe(true)
    expect(resolved.GUEST_ROOMS_ENABLED).toBe(FEATURE_FLAG_DEFAULTS.GUEST_ROOMS_ENABLED)
  })

  it('rejects malformed rows as internal', async () => {
    const { client, supabase } = createTestClient()
    supabase.onQuery(TABLES.featureFlags, { data: [{ key: 'lower', enabled: 'yes' }] })
    expect((await earthRejection(client.flags.get())).code).toBe('internal')
  })

  it('featureFlagsFromDto turns me_get flags into the boolean map', () => {
    const flags = featureFlagsFromDto({
      MAFIA_ACTIVITY_ENABLED: { enabled: true, payload: null, updatedAt: AT },
    })
    expect(flags.MAFIA_ACTIVITY_ENABLED).toBe(true)
    expect(flags.PUBLIC_WORLD_ENABLED).toBe(true)
  })
})

describe('settings', () => {
  it('reads app_settings into a map', async () => {
    const { client, supabase } = createTestClient()
    supabase.onQuery(TABLES.appSettings, {
      data: [{ key: 'web_origin', value: 'https://earth.social' }],
    })
    await expect(client.settings.get()).resolves.toEqual({ web_origin: 'https://earth.social' })
    expect(supabase.lastQuery()).toMatchObject({ table: 'app_settings', columns: 'key, value' })
  })
})

describe('me', () => {
  it('calls me_get and parses MeDto', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.meGet, fixtures.meDto())
    const me = await client.me.get()
    expect(supabase.lastRpc()).toEqual({ name: 'me_get', args: {} })
    expect(me.roleKind).toBe('human')
    expect(me.identity?.handle).toBe('xavier')
    expect(me.flags['PUBLIC_WORLD_ENABLED']?.enabled).toBe(true)
  })

  it('accepts a visitor', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(
      RPC.meGet,
      fixtures.meDto({
        roleKind: 'visitor',
        humanId: null,
        identity: null,
        humanStatus: null,
        humanPassStatus: null,
        context: null,
      }),
    )
    expect((await client.me.get()).humanId).toBeNull()
  })
})

describe('claim', () => {
  it('start maps to claim_start(intent, group_label, invite_token)', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.claimStart, fixtures.claimState({ status: 'started', identity: null }))
    const state = await client.claim.start({ intent: 'start_group', groupLabel: 'Weekend Crew' })
    expect(supabase.lastRpc()).toEqual({
      name: 'claim_start',
      args: { intent: 'start_group', group_label: 'Weekend Crew', invite_token: null },
    })
    expect(state.status).toBe('started')
  })

  it('start rejects join_group without a token before any rpc', async () => {
    const { client, supabase } = createTestClient()
    const error = await earthRejection(client.claim.start({ intent: 'join_group' }))
    expect(error.code).toBe('invalid_input')
    expect(supabase.rpcCalls).toHaveLength(0)
  })

  it('get, setIdentity, complete map their rpcs', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.claimGet, fixtures.claimState())
    expect((await client.claim.get()).status).toBe('identity_set')
    supabase.rpcData(RPC.claimSetIdentity, fixtures.claimState())
    await client.claim.setIdentity({
      displayName: 'Xavier',
      handle: 'xavier',
      avatarMediaId: IDS.media,
    })
    expect(supabase.lastRpc()).toEqual({
      name: 'claim_set_identity',
      args: { display_name: 'Xavier', handle: 'xavier', avatar_media_id: IDS.media },
    })
    supabase.rpcData(RPC.claimComplete, fixtures.claimComplete())
    expect((await client.claim.complete()).groupId).toBe(IDS.group)
    expect(supabase.lastRpc()).toEqual({ name: 'claim_complete', args: {} })
  })

  it('setIdentity validates the handle', async () => {
    const { client } = createTestClient()
    expect(
      (await earthRejection(client.claim.setIdentity({ displayName: 'X', handle: 'No Spaces' })))
        .code,
    ).toBe('invalid_input')
  })

  it('beginVerification only sends provider when given', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.claimVerificationBegin, fixtures.verificationBegin())
    await client.claim.beginVerification()
    expect(supabase.lastRpc()).toEqual({ name: 'claim_verification_begin', args: {} })
    await client.claim.beginVerification('mock')
    expect(supabase.lastRpc()).toEqual({
      name: 'claim_verification_begin',
      args: { provider: 'mock' },
    })
  })

  it('startVerification posts to the server route with a bearer', async () => {
    const { client, fetch } = createTestClient({
      accessToken: 'tok',
      fetchHandler: { json: fixtures.verificationSession() },
    })
    const session = await client.claim.startVerification({ platform: 'ios' })
    expect(session.sessionId).toBe('sess_123')
    const request = fetch.lastRequest()
    expect(request.url).toBe(`https://api.earth.test${SERVER_ROUTES.claimVerificationStart}`)
    expect(request.method).toBe('POST')
    expect(request.headers['authorization']).toBe('Bearer tok')
    expect(request.body).toEqual({ locale: 'en-US', platform: 'ios' })
  })

  it('pollVerification gets the result by id (encoded) with a bearer', async () => {
    const { client, fetch } = createTestClient({
      accessToken: 'tok',
      fetchHandler: { json: fixtures.verificationResult() },
    })
    const result = await client.claim.pollVerification('sess/1')
    expect(result).toEqual({ sessionId: 'sess_123', status: 'verified', failureKind: null })
    expect(fetch.lastRequest().url).toBe('https://api.earth.test/api/claim/verification/sess%2F1')
    expect(fetch.lastRequest().method).toBe('GET')
    expect(fetch.lastRequest().headers['authorization']).toBe('Bearer tok')
    expect(fetch.lastRequest().rawBody).toBeUndefined()
  })

  it('pollVerification parses the { sessionId, status, failureKind } body the route answers', async () => {
    // The GET route answers VerificationResultDto, not the start route's VerificationSessionDto:
    // no providerUrl / expiresAt keys, plus failureKind. Both names reach the same method.
    const { client, fetch } = createTestClient({
      accessToken: 'tok',
      fetchHandler: {
        json: { sessionId: 'sess_123', status: 'review_required', failureKind: 'inconclusive' },
      },
    })
    const failed = await client.claim.verificationResult('sess_123')
    expect(failed).toEqual({
      sessionId: 'sess_123',
      status: 'review_required',
      failureKind: 'inconclusive',
    })
    // A body without failureKind (older server) reads as null rather than a contract error.
    fetch.respond({ json: { sessionId: 'sess_123', status: 'verifying' } })
    expect((await client.claim.pollVerification('sess_123')).failureKind).toBeNull()
    // The route's not_visible (someone else's session) and an empty id are surfaced as such.
    fetch.respond({ status: 404, json: { error: { code: 'not_visible', message: 'not_visible' } } })
    expect((await earthRejection(client.claim.pollVerification('sess_123'))).code).toBe(
      'not_visible',
    )
    expect((await earthRejection(client.claim.pollVerification(''))).code).toBe('invalid_input')
  })

  it('verification routes need a session', async () => {
    const { client, fetch } = createTestClient()
    expect((await earthRejection(client.claim.startVerification({ platform: 'web' }))).code).toBe(
      'not_authenticated',
    )
    expect(fetch.requests).toHaveLength(0)
  })

  it('createReview maps to identity_review_create with default details', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.identityReviewCreate, fixtures.identityReview())
    const review = await client.claim.createReview({ kind: 'help' })
    expect(supabase.lastRpc()).toEqual({
      name: 'identity_review_create',
      args: { kind: 'help', details: {} },
    })
    expect(review.status).toBe('open')
  })

  it('surfaces rpc errors such as duplicate_human', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcError(RPC.claimComplete, postgrestRaise('duplicate_human'))
    expect((await earthRejection(client.claim.complete())).code).toBe('duplicate_human')
  })
})

describe('identity', () => {
  it('update sends every column, null for omitted fields', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.identityUpdate, fixtures.identity({ bio: 'hi' }))
    const updated = await client.identity.update({ bio: 'hi', profileVisibility: 'limited' })
    expect(supabase.lastRpc()).toEqual({
      name: 'identity_update',
      args: {
        display_name: null,
        bio: 'hi',
        avatar_media_id: null,
        profile_visibility: 'limited',
        public_city_visibility: null,
        home_city_area_id: null,
      },
    })
    expect(updated.bio).toBe('hi')
  })

  it('handleAvailable answers false locally for malformed handles', async () => {
    const { client, supabase } = createTestClient()
    await expect(client.identity.handleAvailable('Bad Handle')).resolves.toBe(false)
    expect(supabase.rpcCalls).toHaveLength(0)
    supabase.rpcData(RPC.handleAvailable, true)
    await expect(client.identity.handleAvailable('xavier')).resolves.toBe(true)
    expect(supabase.lastRpc()).toEqual({ name: 'handle_available', args: { handle: 'xavier' } })
    // Handles are case-insensitive and stored lowercase: `@Xavier` asks about `xavier`.
    supabase.rpcData(RPC.handleAvailable, false)
    await expect(client.identity.handleAvailable(' @Xavier ')).resolves.toBe(false)
    expect(supabase.lastRpc()).toEqual({ name: 'handle_available', args: { handle: 'xavier' } })
    expect(supabase.rpcCalls).toHaveLength(2)
    await expect(client.identity.handleAvailable('@@xavier')).resolves.toBe(false)
    await expect(client.identity.handleAvailable('xavier.lee')).resolves.toBe(false)
    expect(supabase.rpcCalls).toHaveLength(2)
  })

  it('uploadAvatar uploads to the avatars bucket, registers media_objects and returns the public url', async () => {
    const { client, supabase } = createTestClient({ randomId: () => 'rid' })
    supabase.rpcData(RPC.meGet, fixtures.meDto({ humanStatus: 'pending', roleKind: 'claiming' }))
    supabase.onQuery(TABLES.mediaObjects, (query) => ({
      data: fixtures.mediaObjectRow({ storage_key: String(query.values?.['storage_key']) }),
      error: null,
    }))
    const media = await client.identity.uploadAvatar({
      body: 'bytes',
      contentType: 'image/jpeg',
      width: 10,
      height: 10,
    })
    expect(supabase.uploads).toEqual([
      {
        bucket: 'avatars',
        path: `${IDS.xavier}/rid.jpg`,
        body: 'bytes',
        options: { contentType: 'image/jpeg', upsert: false },
      },
    ])
    expect(supabase.lastQuery()).toMatchObject({
      table: 'media_objects',
      kind: 'insert',
      columns: 'id, bucket, storage_key, content_type',
      single: 'single',
      values: {
        owner_human_id: IDS.xavier,
        bucket: 'avatars',
        storage_key: `${IDS.xavier}/rid.jpg`,
        content_type: 'image/jpeg',
        width: 10,
        height: 10,
        duration_ms: null,
        byte_size: null,
      },
    })
    expect(media).toEqual({
      id: IDS.media,
      bucket: 'avatars',
      storageKey: `${IDS.xavier}/rid.jpg`,
      contentType: 'image/jpeg',
      url: `https://storage.earth.test/object/public/avatars/${IDS.xavier}/rid.jpg`,
    })
  })
})

describe('media', () => {
  it('private buckets get no public url', async () => {
    const { client, supabase } = createTestClient({ randomId: () => 'rid' })
    supabase.rpcData(RPC.meGet, fixtures.meDto())
    supabase.onQuery(TABLES.mediaObjects, {
      data: fixtures.mediaObjectRow({
        bucket: 'media',
        storage_key: `${IDS.xavier}/rid.mp4`,
        content_type: 'video/mp4',
      }),
    })
    const media = await client.media.upload('bytes', {
      bucket: 'media',
      contentType: 'video/mp4',
      durationMs: 1200,
    })
    expect(media.url).toBeNull()
    expect(supabase.uploads[0]?.path).toBe(`${IDS.xavier}/rid.mp4`)
  })

  it('refuses uploads for callers without a Human and reports storage failures', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(
      RPC.meGet,
      fixtures.meDto({
        roleKind: 'guest',
        humanId: null,
        identity: null,
        humanStatus: null,
        humanPassStatus: null,
        context: null,
      }),
    )
    expect(
      (
        await earthRejection(
          client.media.upload('x', { bucket: 'media', contentType: 'image/png' }),
        )
      ).code,
    ).toBe('not_a_human')
    supabase.rpcData(RPC.meGet, fixtures.meDto())
    supabase.uploadError = { message: 'quota exceeded' }
    const error = await earthRejection(
      client.media.upload('x', { bucket: 'media', contentType: 'image/png' }),
    )
    expect(error.code).toBe('internal')
    expect(error.details).toMatchObject({ reason: 'storage_upload_failed' })
  })

  it('validates the content type', async () => {
    const { client } = createTestClient()
    expect(
      (
        await earthRejection(
          client.media.upload('x', { bucket: 'media', contentType: 'not a type' }),
        )
      ).code,
    ).toBe('invalid_input')
  })

  it('signedUrl asks storage for a signed url', async () => {
    const { client, supabase } = createTestClient()
    const url = await client.media.signedUrl('media', 'k/1.mp4', 60)
    expect(url).toContain('/sign/media/k/1.mp4')
    expect(supabase.signedUrlRequests).toEqual([
      { bucket: 'media', path: 'k/1.mp4', expiresIn: 60 },
    ])
    supabase.signedUrlError = { message: 'no' }
    expect((await earthRejection(client.media.signedUrl('media', 'k/1.mp4'))).code).toBe('internal')
  })

  it('maps content types to extensions', () => {
    expect(extensionForContentType('image/jpeg')).toBe('jpg')
    expect(extensionForContentType('audio/mp4')).toBe('m4a')
    expect(extensionForContentType('application/x-thing')).toBe('xthing')
    expect(extensionForContentType('weird')).toBe('bin')
  })
})
