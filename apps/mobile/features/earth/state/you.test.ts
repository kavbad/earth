import { fixtures } from '@earth/api/testing'
import { ConversationDetailDtoSchema, FeedPageDtoSchema } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { audienceForConversation, groupAudiences, ownPosts } from './you'

describe('SCREEN 24 helpers', () => {
  it('keeps only the viewer’s own posts out of the Friends feed', () => {
    const page = FeedPageDtoSchema.parse(fixtures.feedPage())
    const first = page.cards.find((card) => card.kind === 'post')
    const authorId = first !== undefined && first.kind === 'post' ? first.author.humanId : null
    expect(authorId).not.toBeNull()
    const mine = ownPosts(page.cards, authorId)
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((card) => card.kind === 'post' && card.author.humanId === authorId)).toBe(
      true,
    )
    expect(ownPosts(page.cards, null)).toEqual([])
    expect(ownPosts(page.cards, '00000000-0000-4000-8000-000000000000')).toEqual([])
  })

  it('derives the share audience from a conversation', () => {
    const detail = ConversationDetailDtoSchema.parse(fixtures.conversationDetail())
    const audience = audienceForConversation(detail, fixtures.IDS.xavier)
    expect(audience).not.toBeNull()
    if (detail.groupId !== null) {
      expect(audience).toEqual({ type: 'group', id: detail.groupId, name: detail.title })
    } else {
      expect(audience!.type).toBe('friend')
    }
    expect(groupAudiences([detail]).length).toBe(detail.groupId === null ? 0 : 1)
  })
})
