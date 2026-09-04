/**
 * Stage layout (SCREEN 14): 1 person full screen, 2 balanced split, 3–4 grid, 5+ adaptive grid
 * with active-speaker emphasis. Pure so the selector is unit-tested without a browser.
 */
export const STAGE_LAYOUTS = ['empty', 'single', 'split', 'grid', 'adaptive'] as const
export type StageLayout = (typeof STAGE_LAYOUTS)[number]

/** Participants on stage from which the adaptive layout takes over. */
export const ADAPTIVE_FROM = 5

export function stageLayout(tileCount: number): StageLayout {
  if (!Number.isFinite(tileCount) || tileCount <= 0) return 'empty'
  if (tileCount === 1) return 'single'
  if (tileCount === 2) return 'split'
  if (tileCount < ADAPTIVE_FROM) return 'grid'
  return 'adaptive'
}

export interface StageTile {
  readonly id: string
  readonly isSelf: boolean
  readonly isSpeaking: boolean
  readonly hasVideo: boolean
}

/**
 * Which tile the adaptive layout features. The current featured tile keeps its place while it is
 * still on stage and either still speaking or nobody else is — so the big tile does not jump on
 * every syllable. Self is featured only when alone with nobody else to show.
 */
export function featuredTileId(
  tiles: readonly StageTile[],
  previousFeaturedId: string | null,
): string | null {
  if (tiles.length === 0) return null
  const others = tiles.filter((tile) => !tile.isSelf)
  const candidates = others.length > 0 ? others : tiles
  const previous =
    previousFeaturedId === null
      ? undefined
      : candidates.find((tile) => tile.id === previousFeaturedId)
  const speaking = candidates.filter((tile) => tile.isSpeaking)
  if (previous !== undefined && (previous.isSpeaking || speaking.length === 0)) return previous.id
  if (speaking.length > 0) return speaking[0]?.id ?? null
  if (previous !== undefined) return previous.id
  const withVideo = candidates.find((tile) => tile.hasVideo)
  return (withVideo ?? candidates[0])?.id ?? null
}

/**
 * Stage order: the featured tile first (adaptive layout renders it large), everyone else in the
 * given order so tiles do not shuffle when someone speaks.
 */
export function orderStageTiles<T extends StageTile>(
  tiles: readonly T[],
  featuredId: string | null,
): T[] {
  if (featuredId === null) return [...tiles]
  const featured = tiles.find((tile) => tile.id === featuredId)
  if (featured === undefined) return [...tiles]
  return [featured, ...tiles.filter((tile) => tile.id !== featuredId)]
}
