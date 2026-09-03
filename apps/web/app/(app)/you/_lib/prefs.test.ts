import { describe, expect, it } from 'vitest'

import { createMemoryStorage } from '../../../../lib/storage'
import {
  DEFAULT_AUDIENCE,
  LIVE_DEFAULTS_FALLBACK,
  LIVE_JOIN_POLICY_CHOICES,
  LIVE_VISIBILITY_CHOICES,
  prefKey,
  readDefaultAudience,
  readLiveDefaults,
  writeDefaultAudience,
  writeLiveDefaults,
} from './prefs'

const HUMAN = '11111111-1111-4111-8111-111111111111'

describe('device preferences (SCREEN 25 Privacy)', () => {
  it('defaults the post audience to Friends and remembers a change per Human', () => {
    const storage = createMemoryStorage()
    expect(readDefaultAudience(storage, HUMAN)).toBe(DEFAULT_AUDIENCE)
    writeDefaultAudience(storage, HUMAN, 'city')
    expect(readDefaultAudience(storage, HUMAN)).toBe('city')
    expect(readDefaultAudience(storage, 'someone-else')).toBe('friends')
    expect(storage.values.get(prefKey(HUMAN, 'defaultAudience'))).toBe('city')
  })

  it('ignores values that are not audiences', () => {
    const storage = createMemoryStorage({ [prefKey(HUMAN, 'defaultAudience')]: 'everyone' })
    expect(readDefaultAudience(storage, HUMAN)).toBe('friends')
    expect(readDefaultAudience(null, HUMAN)).toBe('friends')
  })

  it('keeps Live defaults within the Open up choices and falls back to friends / friends', () => {
    const storage = createMemoryStorage()
    expect(readLiveDefaults(storage, HUMAN)).toEqual(LIVE_DEFAULTS_FALLBACK)
    writeLiveDefaults(storage, HUMAN, { visibility: 'city', joinPolicy: 'request' })
    expect(readLiveDefaults(storage, HUMAN)).toEqual({ visibility: 'city', joinPolicy: 'request' })
    writeLiveDefaults(storage, HUMAN, { visibility: 'group', joinPolicy: 'group' })
    expect(readLiveDefaults(storage, HUMAN)).toEqual(LIVE_DEFAULTS_FALLBACK)
    expect(LIVE_VISIBILITY_CHOICES).not.toContain('group')
    expect(LIVE_JOIN_POLICY_CHOICES).not.toContain('group')
  })
})
