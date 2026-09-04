import { describe, expect, it } from 'vitest'

import { isMobileUserAgent } from './userAgent'

describe('isMobileUserAgent ("Open in Earth" only on phones)', () => {
  it('recognises iOS and Android browsers and nothing else', () => {
    expect(isMobileUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe(true)
    expect(isMobileUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe(true)
    expect(isMobileUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)')).toBe(false)
    expect(isMobileUserAgent('')).toBe(false)
  })
})
