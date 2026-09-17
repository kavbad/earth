import { describe, expect, it } from 'vitest'

import { preconnectOrigin } from './preconnect'

describe('preconnectOrigin (Guest page warm-up)', () => {
  it('maps websocket URLs to the http origin and keeps http ones', () => {
    expect(preconnectOrigin('wss://livekit.earth.social/rtc?x=1')).toBe(
      'https://livekit.earth.social',
    )
    expect(preconnectOrigin('ws://localhost:7880')).toBe('http://localhost:7880')
    expect(preconnectOrigin('https://livekit.earth.social')).toBe('https://livekit.earth.social')
  })

  it('refuses anything a browser cannot preconnect to', () => {
    expect(preconnectOrigin('not a url')).toBeNull()
    expect(preconnectOrigin('ftp://x')).toBeNull()
  })
})
