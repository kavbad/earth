import { describe, expect, it } from 'vitest'

import { canPost, postMediaType, postText, postTypeFor } from './media'

describe('composer media rules (SCREEN 06)', () => {
  it('accepts only images and videos', () => {
    expect(postMediaType('image/jpeg')).toBe('image')
    expect(postMediaType('VIDEO/MP4')).toBe('video')
    expect(postMediaType('application/pdf')).toBeNull()
    expect(postMediaType('')).toBeNull()
  })

  it('derives the post type from the attachments', () => {
    expect(postTypeFor([])).toBe('text')
    expect(postTypeFor([{ mediaType: 'image' }])).toBe('image')
    expect(postTypeFor([{ mediaType: 'image' }, { mediaType: 'video' }])).toBe('video')
  })

  it('requires text or media', () => {
    expect(canPost('   ', 0)).toBe(false)
    expect(canPost('hi', 0)).toBe(true)
    expect(canPost('', 1)).toBe(true)
    expect(postText('  hello  ')).toBe('hello')
    expect(postText('  ')).toBeNull()
  })
})
