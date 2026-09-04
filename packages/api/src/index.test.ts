import { describe, expect, it } from 'vitest'

import { PACKAGE_NAME, RPC, SERVER_ROUTES, createEarthClient } from './index'
import { createFakeFetch } from './testing/fake-fetch'
import { createFakeSupabase } from './testing/fake-supabase'

describe('@earth/api', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@earth/api')
  })

  it('createEarthClient exposes every namespace of ARCHITECTURE §7', () => {
    const client = createEarthClient({
      supabase: createFakeSupabase(),
      serverBaseUrl: 'https://api.earth.test',
      fetch: createFakeFetch().fetch,
    })
    expect(Object.keys(client).sort()).toEqual(
      [
        'accessToken',
        'analytics',
        'claim',
        'conversations',
        'diagnostics',
        'feed',
        'flags',
        'groups',
        'guest',
        'identity',
        'live',
        'location',
        'map',
        'me',
        'media',
        'notifications',
        'places',
        'posts',
        'presence',
        'rooms',
        'safety',
        'search',
        'settings',
        'social',
        'transport',
      ].sort(),
    )
  })

  it('RPC names follow public.<noun>_<verb> and routes live under /api', () => {
    for (const name of Object.values(RPC)) expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/)
    expect(SERVER_ROUTES.roomToken('r1')).toBe('/api/rooms/r1/token')
    expect(SERVER_ROUTES.feed).toBe('/api/feed')
  })

  it('accessToken reports the session token', async () => {
    const client = createEarthClient({
      supabase: createFakeSupabase({ accessToken: 'tok' }),
      serverBaseUrl: 'https://api.earth.test',
      fetch: createFakeFetch().fetch,
    })
    await expect(client.accessToken()).resolves.toBe('tok')
  })
})

describe('rejectInsteadOfThrow', () => {
  it('turns synchronous validation failures into rejections on every namespace', async () => {
    const client = createEarthClient({
      supabase: createFakeSupabase(),
      serverBaseUrl: 'https://api.earth.test',
      fetch: createFakeFetch().fetch,
    })
    const promise = client.groups.get('not-a-uuid' as never)
    expect(promise).toBeInstanceOf(Promise)
    await expect(promise).rejects.toMatchObject({ name: 'EarthError', code: 'invalid_input' })
    await expect(
      client.conversations.messages.reactions.toggle({ messageId: 'x' as never, reaction: '' }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
})
