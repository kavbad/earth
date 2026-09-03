import { describe, expect, it } from 'vitest'

import { ADAPTIVE_FROM, type StageTile, featuredTileId, orderStageTiles, stageLayout } from './stage'

function tile(id: string, overrides: Partial<StageTile> = {}): StageTile {
  return { id, isSelf: false, isSpeaking: false, hasVideo: true, ...overrides }
}

describe('stageLayout (SCREEN 14)', () => {
  it('maps participant counts to the spec layouts', () => {
    expect(stageLayout(0)).toBe('empty')
    expect(stageLayout(1)).toBe('single')
    expect(stageLayout(2)).toBe('split')
    expect(stageLayout(3)).toBe('grid')
    expect(stageLayout(4)).toBe('grid')
    expect(stageLayout(ADAPTIVE_FROM)).toBe('adaptive')
    expect(stageLayout(12)).toBe('adaptive')
  })

  it('treats nonsense counts as empty', () => {
    expect(stageLayout(-1)).toBe('empty')
    expect(stageLayout(Number.NaN)).toBe('empty')
  })
})

describe('featuredTileId (active-speaker emphasis)', () => {
  it('features the speaker when nobody was featured', () => {
    const tiles = [tile('a'), tile('b', { isSpeaking: true }), tile('c')]
    expect(featuredTileId(tiles, null)).toBe('b')
  })

  it('keeps the featured tile while it still speaks or nobody else does', () => {
    const still = [tile('a'), tile('b', { isSpeaking: true }), tile('c')]
    expect(featuredTileId(still, 'b')).toBe('b')
    const quiet = [tile('a'), tile('b'), tile('c')]
    expect(featuredTileId(quiet, 'b')).toBe('b')
  })

  it('moves to the new speaker once the featured one is silent', () => {
    const tiles = [tile('a'), tile('b'), tile('c', { isSpeaking: true })]
    expect(featuredTileId(tiles, 'b')).toBe('c')
  })

  it('never features self while others are present, and prefers video otherwise', () => {
    const tiles = [tile('me', { isSelf: true, isSpeaking: true }), tile('a', { hasVideo: false }), tile('b')]
    expect(featuredTileId(tiles, null)).toBe('b')
    expect(featuredTileId([tile('me', { isSelf: true })], null)).toBe('me')
    expect(featuredTileId([], null)).toBeNull()
  })

  it('forgets a featured tile that left', () => {
    const tiles = [tile('a'), tile('c')]
    expect(featuredTileId(tiles, 'b')).toBe('a')
  })
})

describe('orderStageTiles', () => {
  it('puts the featured tile first and keeps the rest stable', () => {
    const tiles = [tile('a'), tile('b'), tile('c')]
    expect(orderStageTiles(tiles, 'b').map((t) => t.id)).toEqual(['b', 'a', 'c'])
    expect(orderStageTiles(tiles, null).map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(orderStageTiles(tiles, 'zzz').map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })
})
