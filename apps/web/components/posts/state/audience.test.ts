import { describe, expect, it } from 'vitest'

import { createMemoryStorage } from '../../../lib/storage'
import {
  audienceOptions,
  composerAudienceReducer,
  defaultAudience,
  initialComposerAudience,
  isMateriallyOutward,
  needsAudienceConfirmation,
  readLastAudience,
  rememberLastAudience,
} from './audience'

const HUMAN = '11111111-1111-4111-8111-111111111111'

describe('audience options and defaults (SCREEN 06, spec §72)', () => {
  it('offers every audience for a post and only narrower ones for a reply', () => {
    expect(audienceOptions(null)).toEqual(['friends', 'neighborhood', 'city', 'world'])
    expect(audienceOptions('city')).toEqual(['friends', 'neighborhood', 'city'])
    expect(audienceOptions('friends')).toEqual(['friends'])
  })

  it('defaults to the Home radius, then the usual audience, then Friends — within the cap', () => {
    expect(defaultAudience({ requested: 'city', last: 'friends', cap: null })).toBe('city')
    expect(defaultAudience({ requested: null, last: 'world', cap: null })).toBe('world')
    expect(defaultAudience({ requested: null, last: null, cap: null })).toBe('friends')
    expect(defaultAudience({ requested: 'world', last: null, cap: 'neighborhood' })).toBe(
      'neighborhood',
    )
  })

  it('remembers the last audience per Human on the device', () => {
    const storage = createMemoryStorage()
    expect(readLastAudience(storage, HUMAN)).toBeNull()
    rememberLastAudience(storage, HUMAN, 'city')
    expect(readLastAudience(storage, HUMAN)).toBe('city')
    expect(readLastAudience(storage, null)).toBeNull()
    storage.setItem(`earth.compose.audience.${HUMAN}`, 'everyone')
    expect(readLastAudience(storage, HUMAN)).toBeNull()
  })
})

describe('materially outward confirmation', () => {
  it('asks for World and for two or more steps outward, never for narrowing or one local step', () => {
    expect(isMateriallyOutward('friends', 'world')).toBe(true)
    expect(isMateriallyOutward('city', 'world')).toBe(true)
    expect(isMateriallyOutward('friends', 'city')).toBe(true)
    expect(isMateriallyOutward('friends', 'neighborhood')).toBe(false)
    expect(isMateriallyOutward('neighborhood', 'city')).toBe(false)
    expect(isMateriallyOutward('world', 'friends')).toBe(false)
    expect(isMateriallyOutward('city', 'city')).toBe(false)
  })

  it('measures from the usual audience (Friends when unknown) and never asks twice', () => {
    expect(needsAudienceConfirmation({ chosen: 'world', usual: null, confirmed: [] })).toBe(true)
    expect(needsAudienceConfirmation({ chosen: 'world', usual: 'world', confirmed: [] })).toBe(
      false,
    )
    expect(
      needsAudienceConfirmation({ chosen: 'city', usual: 'friends', confirmed: ['city'] }),
    ).toBe(false)
    expect(
      needsAudienceConfirmation({ chosen: 'neighborhood', usual: 'friends', confirmed: [] }),
    ).toBe(false)
  })
})

describe('composer audience reducer', () => {
  const start = initialComposerAudience({ requested: null, last: 'friends', cap: null })

  it('applies a mild change directly and holds a material one for confirmation', () => {
    const mild = composerAudienceReducer(start, { type: 'choose', audience: 'neighborhood' })
    expect(mild.audience).toBe('neighborhood')
    expect(mild.pending).toBeNull()

    const held = composerAudienceReducer(start, { type: 'choose', audience: 'world' })
    expect(held.audience).toBe('friends')
    expect(held.pending).toBe('world')

    const cancelled = composerAudienceReducer(held, { type: 'cancel' })
    expect(cancelled.audience).toBe('friends')
    expect(cancelled.pending).toBeNull()

    const confirmed = composerAudienceReducer(held, { type: 'confirm' })
    expect(confirmed.audience).toBe('world')
    expect(confirmed.confirmed).toEqual(['world'])

    // Back to Friends and out to World again: no second sheet in the same composer.
    const back = composerAudienceReducer(confirmed, { type: 'choose', audience: 'friends' })
    const again = composerAudienceReducer(back, { type: 'choose', audience: 'world' })
    expect(again.audience).toBe('world')
    expect(again.pending).toBeNull()
  })

  it('refuses an audience beyond a reply cap', () => {
    const reply = initialComposerAudience({ requested: 'world', last: null, cap: 'city' })
    expect(reply.audience).toBe('city')
    expect(composerAudienceReducer(reply, { type: 'choose', audience: 'world' })).toBe(reply)
    expect(composerAudienceReducer(reply, { type: 'confirm' })).toBe(reply)
  })
})
