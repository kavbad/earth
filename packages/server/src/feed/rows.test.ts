import { describe, expect, it } from 'vitest'

import {
  FeedCandidatesResultSchema,
  LiveCandidatesResultSchema,
  candidateOf,
  liveCardFrom,
  postCardFrom,
  FeedCandidateRowSchema,
} from './rows'
import { hoursBefore, liveRoom, liveRow, participant, postRow, postView } from '../test/fixtures'

describe('row schemas', () => {
  it('accepts bare arrays and wrapped results', () => {
    const bare = FeedCandidatesResultSchema.parse([postRow(1)])
    expect(bare.rows).toHaveLength(1)
    expect(bare.areaName).toBeNull()
    const wrapped = FeedCandidatesResultSchema.parse({
      candidates: [postRow(1)],
      areaName: 'Mission',
    })
    expect(wrapped.rows).toHaveLength(1)
    expect(wrapped.areaName).toBe('Mission')
    expect(FeedCandidatesResultSchema.parse(null)).toEqual({ rows: [], areaName: null })
    expect(LiveCandidatesResultSchema.parse([liveRoom(1)]).rows).toHaveLength(1)
  })

  it('requires the rendering payload matching the kind', () => {
    expect(FeedCandidateRowSchema.safeParse({ ...postRow(1), post: null }).success).toBe(false)
    expect(FeedCandidateRowSchema.safeParse({ ...liveRow(1), live: null }).success).toBe(false)
    expect(FeedCandidateRowSchema.safeParse(liveRow(1)).success).toBe(true)
  })

  it('candidateOf strips rendering payloads', () => {
    const row = FeedCandidateRowSchema.parse(postRow(1))
    const candidate = candidateOf(row)
    expect('post' in candidate).toBe(false)
    expect(candidate.id).toBe(row.id)
  })

  it('postCardFrom builds a post card keyed by post id', () => {
    const card = postCardFrom(FeedCandidateRowSchema.parse(postRow(2)))
    expect(card.kind).toBe('post')
    expect(card.id).toBe(card.post.id)
    expect(card.author.displayName).toBe('Author 2')
  })
})

describe('liveCardFrom', () => {
  it('names the room for the viewer: friend first, "X + Y are live"', () => {
    const room = liveRoom(1, {
      participants: [
        participant(1, { displayName: 'Ben', relationToViewer: 'other', joinedAt: hoursBefore(1) }),
        participant(2, {
          displayName: 'Kavon',
          relationToViewer: 'friend',
          avatarUrl: 'https://cdn.earth.social/kavon.png',
        }),
        participant(3, { displayName: 'Me', relationToViewer: 'self' }),
        participant(4, { displayName: 'Watcher', mediaState: 'watching' }),
      ],
    })
    const card = liveCardFrom(room)
    expect(card.title).toBe('Kavon + Ben are live')
    expect(card.participantNames).toEqual(['Kavon', 'Ben'])
    expect(card.participantAvatars).toEqual(['https://cdn.earth.social/kavon.png', null])
    expect(card.participantCount).toBe(2)
    expect(card.id).toBe(room.roomId)
    expect(card.roomId).toBe(room.roomId)
    expect(card.visibility).toBe('friends')
  })

  it('titles group rooms with the group name and honours the RPC participant count', () => {
    const card = liveCardFrom(
      liveRoom(2, { contextType: 'group', contextTitle: 'Weekend Crew', participantCount: 5 }),
    )
    expect(card.title).toBe('Weekend Crew is live')
    expect(card.contextTitle).toBe('Weekend Crew')
    expect(card.participantCount).toBe(5)
  })

  it('handles a single participant and an empty room', () => {
    expect(liveCardFrom(liveRoom(3)).title).toBe('Xavier is live')
    const empty = liveCardFrom(liveRoom(4, { participants: [] }))
    expect(empty.title).toBe('Live')
    expect(empty.participantCount).toBe(0)
  })
})

describe('adversarial: payload ids must match the candidate id', () => {
  it('refuses a post payload for another post and a live payload for another room', () => {
    const row = postRow(1)
    expect(FeedCandidateRowSchema.safeParse({ ...row, post: postView(2) }).success).toBe(false)
    expect(FeedCandidateRowSchema.safeParse({ ...liveRow(3), live: liveRoom(4) }).success).toBe(
      false,
    )
    expect(FeedCandidateRowSchema.safeParse(row).success).toBe(true)
    expect(FeedCandidateRowSchema.safeParse(liveRow(3)).success).toBe(true)
  })
})
