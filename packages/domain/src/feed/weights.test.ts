import { describe, expect, it } from 'vitest'

import {
  CITY_WEIGHTS,
  FRIENDS_WEIGHTS,
  NEIGHBORHOOD_WEIGHTS,
  sumWeights,
  weightsForScope,
  WORLD_WEIGHTS,
} from './weights'

describe('feed weights (spec §65, §68)', () => {
  it('match the spec tables exactly', () => {
    expect(FRIENDS_WEIGHTS).toEqual({
      relationship: 0.35,
      now: 0.25,
      groupContext: 0.15,
      recency: 0.15,
      quality: 0.1,
    })
    expect(WORLD_WEIGHTS).toEqual({
      interest: 0.25,
      social: 0.2,
      quality: 0.2,
      recency: 0.15,
      novelty: 0.1,
      placeAffinity: 0.1,
    })
  })

  it('every weight set sums to 1', () => {
    for (const weights of [FRIENDS_WEIGHTS, WORLD_WEIGHTS, NEIGHBORHOOD_WEIGHTS, CITY_WEIGHTS]) {
      expect(sumWeights(weights)).toBeCloseTo(1, 10)
    }
  })

  it('neighborhood and city reuse the World shape with place affinity boosted', () => {
    expect(Object.keys(NEIGHBORHOOD_WEIGHTS).sort()).toEqual(Object.keys(WORLD_WEIGHTS).sort())
    expect(Object.keys(CITY_WEIGHTS).sort()).toEqual(Object.keys(WORLD_WEIGHTS).sort())
    expect(NEIGHBORHOOD_WEIGHTS.placeAffinity).toBeGreaterThan(CITY_WEIGHTS.placeAffinity)
    expect(CITY_WEIGHTS.placeAffinity).toBeGreaterThan(WORLD_WEIGHTS.placeAffinity)
    expect(weightsForScope('world')).toBe(WORLD_WEIGHTS)
    expect(weightsForScope('city')).toBe(CITY_WEIGHTS)
    expect(weightsForScope('neighborhood')).toBe(NEIGHBORHOOD_WEIGHTS)
  })
})
