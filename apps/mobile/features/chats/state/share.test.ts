import { describe, expect, it } from 'vitest'

import { fallbackShareChannel, shareChannelFor, shareInviteLink } from './share'

describe('invite link sharing (group_invite_shared channel)', () => {
  it('maps the share sheet outcome to a channel', () => {
    expect(shareChannelFor({ action: 'sharedAction' })).toBe('system_share')
    expect(shareChannelFor({ action: 'dismissedAction' })).toBeNull()
    expect(fallbackShareChannel(true)).toBe('copy_link')
    expect(fallbackShareChannel(false)).toBe('other')
  })

  it('tracks a system share and nothing when dismissed', async () => {
    const shared: string[] = []
    const deps = {
      share: async (url: string) => {
        shared.push(url)
        return { action: 'sharedAction' as const }
      },
      copy: async () => true,
    }
    expect(await shareInviteLink('https://earth.social/g/abc', deps)).toBe('system_share')
    expect(shared).toEqual(['https://earth.social/g/abc'])
    expect(
      await shareInviteLink('https://earth.social/g/abc', {
        ...deps,
        share: async () => ({ action: 'dismissedAction' as const }),
      }),
    ).toBeNull()
  })

  it('falls back to the clipboard when the sheet cannot open', async () => {
    const copied: string[] = []
    const failing = {
      share: async () => {
        throw new Error('unavailable')
      },
      copy: async (url: string) => {
        copied.push(url)
        return true
      },
    }
    expect(await shareInviteLink('https://earth.social/g/abc', failing)).toBe('copy_link')
    expect(copied).toEqual(['https://earth.social/g/abc'])
    expect(
      await shareInviteLink('https://earth.social/g/abc', {
        ...failing,
        copy: async () => {
          throw new Error('no clipboard')
        },
      }),
    ).toBe('other')
  })
})
