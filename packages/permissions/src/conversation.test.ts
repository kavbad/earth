import { describe, expect, it } from 'vitest'

import { canReadConversation, canSendMessage } from './conversation'
import type { Viewer } from './types'

const member = (extra: Partial<Viewer> = {}): Viewer => ({
  kind: 'human',
  relationToAuthor: 'other',
  blockedEitherWay: false,
  isConversationMember: true,
  ...extra,
})

describe('conversations (mirror of earth.can_view_conversation / message_send)', () => {
  it('members read and send; non-members do neither', () => {
    for (const conversationType of ['direct', 'group'] as const) {
      expect(canReadConversation(member(), { conversationType })).toBe(true)
      expect(canSendMessage(member(), { conversationType })).toEqual({ allowed: true })
      expect(
        canReadConversation(member({ isConversationMember: false }), { conversationType }),
      ).toBe(false)
      expect(canSendMessage(member({ isConversationMember: false }), { conversationType })).toEqual(
        {
          allowed: false,
          reason: 'conversation_not_found',
        },
      )
    }
  })

  it('a block suppresses direct conversations but coexists with group membership (spec §56)', () => {
    const blocked = member({ blockedEitherWay: true })
    expect(canReadConversation(blocked, { conversationType: 'direct' })).toBe(false)
    expect(canSendMessage(blocked, { conversationType: 'direct' })).toEqual({
      allowed: false,
      reason: 'blocked',
    })
    expect(canReadConversation(blocked, { conversationType: 'group' })).toBe(true)
    expect(canSendMessage(blocked, { conversationType: 'group' })).toEqual({ allowed: true })
  })

  it('only active Humans read or send', () => {
    expect(
      canSendMessage(
        { kind: 'visitor', blockedEitherWay: false, isConversationMember: true },
        { conversationType: 'group' },
      ),
    ).toEqual({ allowed: false, reason: 'not_authenticated' })
    for (const kind of ['guest', 'claiming', 'service'] as const) {
      expect(
        canSendMessage(
          { kind, blockedEitherWay: false, isConversationMember: true },
          { conversationType: 'group' },
        ),
      ).toEqual({ allowed: false, reason: 'not_a_human' })
    }
    for (const kind of ['visitor', 'guest', 'claiming'] as const) {
      expect(
        canReadConversation(
          { kind, blockedEitherWay: false, isConversationMember: true },
          { conversationType: 'group' },
        ),
      ).toBe(false)
    }
    expect(
      canReadConversation(
        { kind: 'service', blockedEitherWay: false },
        { conversationType: 'direct' },
      ),
    ).toBe(true)
  })
})
