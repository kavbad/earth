import { asConversationId, asGroupId } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { messageEventContext } from './analytics'

const conversationId = asConversationId('11111111-1111-4111-8111-111111111111')
const groupId = asGroupId('22222222-2222-4222-8222-222222222222')

describe('messageEventContext (spec §96 identity properties)', () => {
  it('carries the group id only when the conversation has one', () => {
    expect(messageEventContext({ type: 'group', groupId }, conversationId)).toEqual({
      conversationId,
      conversationType: 'group',
      groupId,
    })
    expect(messageEventContext({ type: 'direct', groupId: null }, conversationId)).toEqual({
      conversationId,
      conversationType: 'direct',
    })
  })

  it('assumes a direct conversation before the detail has loaded', () => {
    expect(messageEventContext(undefined, conversationId)).toEqual({
      conversationId,
      conversationType: 'direct',
    })
  })
})
