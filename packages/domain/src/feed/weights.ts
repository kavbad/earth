/**
 * Feed ranking weights (spec §65, §68; ARCHITECTURE §9). Deterministic weighted ranking, no ML.
 * Every weight set sums to 1 so a score of components in [0, 1] stays in [0, 1].
 */
import type { Scope } from '../enums'

/** Spec §65 Friends score. */
export const FRIENDS_WEIGHTS = {
  relationship: 0.35,
  now: 0.25,
  groupContext: 0.15,
  recency: 0.15,
  quality: 0.1,
} as const
export type FriendsWeights = typeof FRIENDS_WEIGHTS
export type FriendsComponent = keyof FriendsWeights

/** Spec §68 World score. */
export const WORLD_WEIGHTS = {
  interest: 0.25,
  social: 0.2,
  quality: 0.2,
  recency: 0.15,
  novelty: 0.1,
  placeAffinity: 0.1,
} as const
export type WorldWeights = { readonly [K in keyof typeof WORLD_WEIGHTS]: number }
export type WorldComponent = keyof WorldWeights

/**
 * Neighborhood reuses the World shape with `placeAffinity` boosted (spec §66: "relevant City
 * posts with local proximity", "eventually places/events"). The boost is paid for by interest,
 * quality and novelty so the total still sums to 1.
 */
export const NEIGHBORHOOD_WEIGHTS: WorldWeights = {
  interest: 0.2,
  social: 0.2,
  quality: 0.15,
  recency: 0.15,
  novelty: 0.05,
  placeAffinity: 0.25,
}

/**
 * City reuses the World shape with a milder `placeAffinity` boost than Neighborhood (spec §67:
 * city posts, followed/friend City activity, relevant city-level public objects).
 */
export const CITY_WEIGHTS: WorldWeights = {
  interest: 0.2,
  social: 0.2,
  quality: 0.2,
  recency: 0.15,
  novelty: 0.05,
  placeAffinity: 0.2,
}

/** World-shaped weights for a non-Friends scope. */
export function weightsForScope(scope: Exclude<Scope, 'friends'>): WorldWeights {
  switch (scope) {
    case 'neighborhood':
      return NEIGHBORHOOD_WEIGHTS
    case 'city':
      return CITY_WEIGHTS
    case 'world':
      return WORLD_WEIGHTS
  }
}

export function sumWeights(weights: Readonly<Record<string, number>>): number {
  return Object.values(weights).reduce((sum, w) => sum + w, 0)
}
