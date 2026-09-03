/**
 * SCREEN 06 audience: the default, what a reply may offer, and when moving outward asks once.
 */
import { describe, expect, it } from 'vitest'

import {
  audienceOptions,
  composerAudienceReducer,
  defaultAudience,
  initialComposerAudience,
  isMateriallyOutward,
  lastAudienceStorageKey,
  needsAudienceConfirmation,
  parseLastAudience,
} from './audience'

describe('defaults and options', () => {
  it('prefers the Home radius, then the usual audience, then Friends', () => {
    expect(defaultAudience({ requested: 'city', last: 'world', cap: null })).toBe('city')
    expect(defaultAudience({ requested: null, last: 'world', cap: null })).toBe('world')
    expect(defaultAudience({ requested: null, last: null, cap: null })).toBe('friends')
  })

  it('never starts a reply wider than the root (spec §72)', () => {
    expect(defaultAudience({ requested: 'world', last: null, cap: 'neighborhood' })).toBe(
      'neighborhood',
    )
    expect(audienceOptions('city')).toEqual(['friends', 'neighborhood', 'city'])
    expect(audienceOptions(null)).toEqual(['friends', 'neighborhood', 'city', 'world'])
  })

  it('parses the remembered audience and ignores junk', () => {
    expect(parseLastAudience('world')).toBe('world')
    expect(parseLastAudience('everyone')).toBeNull()
    expect(parseLastAudience(null)).toBeNull()
    expect(lastAudienceStorageKey('h1')).toBe('earth.compose.audience.h1')
  })
})

describe('material widening', () => {
  it('asks for World from anywhere and for two-step widenings', () => {
    expect(isMateriallyOutward('friends', 'world')).toBe(true)
    expect(isMateriallyOutward('city', 'world')).toBe(true)
    expect(isMateriallyOutward('friends', 'city')).toBe(true)
    expect(isMateriallyOutward('neighborhood', 'world')).toBe(true)
  })

  it('does not ask for one local step, the same audience, or narrowing', () => {
    expect(isMateriallyOutward('friends', 'neighborhood')).toBe(false)
    expect(isMateriallyOutward('neighborhood', 'city')).toBe(false)
    expect(isMateriallyOutward('city', 'city')).toBe(false)
    expect(isMateriallyOutward('world', 'friends')).toBe(false)
  })

  it('treats an unknown usual audience as Friends and never asks twice', () => {
    expect(needsAudienceConfirmation({ chosen: 'world', usual: null, confirmed: [] })).toBe(true)
    expect(needsAudienceConfirmation({ chosen: 'world', usual: null, confirmed: ['world'] })).toBe(
      false,
    )
    expect(needsAudienceConfirmation({ chosen: 'city', usual: 'city', confirmed: [] })).toBe(false)
  })
})

describe('composerAudienceReducer', () => {
  const start = initialComposerAudience({ requested: null, last: 'friends', cap: null })

  it('applies a quiet choice at once', () => {
    const next = composerAudienceReducer(start, { type: 'choose', audience: 'neighborhood' })
    expect(next.audience).toBe('neighborhood')
    expect(next.pending).toBeNull()
  })

  it('holds a material widening until confirmed, then remembers it', () => {
    const asked = composerAudienceReducer(start, { type: 'choose', audience: 'world' })
    expect(asked.audience).toBe('friends')
    expect(asked.pending).toBe('world')
    const cancelled = composerAudienceReducer(asked, { type: 'cancel' })
    expect(cancelled.audience).toBe('friends')
    expect(cancelled.pending).toBeNull()
    const confirmed = composerAudienceReducer(asked, { type: 'confirm' })
    expect(confirmed.audience).toBe('world')
    expect(confirmed.confirmed).toEqual(['world'])
    const back = composerAudienceReducer(confirmed, { type: 'choose', audience: 'friends' })
    expect(composerAudienceReducer(back, { type: 'choose', audience: 'world' }).audience).toBe(
      'world',
    )
  })

  it('ignores audiences beyond a reply cap and confirm without a pending choice', () => {
    const capped = initialComposerAudience({ requested: null, last: null, cap: 'city' })
    expect(composerAudienceReducer(capped, { type: 'choose', audience: 'world' })).toBe(capped)
    expect(composerAudienceReducer(capped, { type: 'confirm' })).toBe(capped)
    expect(composerAudienceReducer(capped, { type: 'cancel' })).toBe(capped)
  })
})
