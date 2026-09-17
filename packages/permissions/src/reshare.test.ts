import { AUDIENCE } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { allowedReshareAudiences, canReshareTo } from './reshare'

describe('reshare narrowing (spec §72)', () => {
  it('allows only audiences equal to or narrower than the source, narrow → wide', () => {
    expect(allowedReshareAudiences('friends')).toEqual(['friends'])
    expect(allowedReshareAudiences('neighborhood')).toEqual(['friends', 'neighborhood'])
    expect(allowedReshareAudiences('city')).toEqual(['friends', 'neighborhood', 'city'])
    expect(allowedReshareAudiences('world')).toEqual([...AUDIENCE])
  })

  it('a Friends post cannot be reshared to World', () => {
    expect(canReshareTo('friends', 'world')).toBe(false)
    expect(canReshareTo('friends', 'friends')).toBe(true)
    expect(canReshareTo('world', 'friends')).toBe(true)
    for (const source of AUDIENCE) {
      for (const target of AUDIENCE) {
        expect(canReshareTo(source, target)).toBe(
          AUDIENCE.indexOf(target) <= AUDIENCE.indexOf(source),
        )
      }
    }
  })

  it('reshare_policy none allows nothing', () => {
    for (const source of AUDIENCE) {
      expect(allowedReshareAudiences(source, 'none')).toEqual([])
      expect(canReshareTo(source, 'friends', 'none')).toBe(false)
    }
  })
})
