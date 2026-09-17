import { describe, expect, it } from 'vitest'

import { STORAGE_BUCKETS, mediaRouteUrl } from './rpc'

describe('mediaRouteUrl', () => {
  const key = '22222222-2222-4222-8222-222222222222/photo.png'

  it('is the server tier media route, the shape earth.media_url() writes into post media', () => {
    expect(mediaRouteUrl('https://earth.social', STORAGE_BUCKETS.media, key)).toBe(
      `https://earth.social/api/media/media/${key}`,
    )
    expect(mediaRouteUrl('http://localhost:3000', STORAGE_BUCKETS.voice, key)).toBe(
      `http://localhost:3000/api/media/voice/${key}`,
    )
  })

  it('keeps the key as path segments and tolerates a trailing slash on the origin', () => {
    const url = mediaRouteUrl('https://earth.social/', STORAGE_BUCKETS.media, key)
    expect(url).toBe(`https://earth.social/api/media/media/${key}`)
    expect(url).not.toContain('%2F')
  })
})
