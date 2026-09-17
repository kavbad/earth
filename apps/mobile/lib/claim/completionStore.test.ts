import { describe, expect, it, vi } from 'vitest'

import {
  consumeCompletion,
  getCompletionSnapshot,
  setCompletion,
  subscribeCompletion,
} from './completionStore'
import { clearClaimTracked, isClaimTracked, markClaimTracked } from './tracking'

const RECORD = {
  humanId: 'h' as never,
  groupId: 'g' as never,
  conversationId: 'c' as never,
  intent: 'start_group' as const,
}

describe('completion store', () => {
  it('publishes the completion once and clears it when consumed', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeCompletion(listener)
    expect(getCompletionSnapshot()).toBeNull()
    setCompletion(RECORD)
    expect(getCompletionSnapshot()).toEqual(RECORD)
    consumeCompletion()
    expect(getCompletionSnapshot()).toBeNull()
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
    setCompletion(RECORD)
    expect(listener).toHaveBeenCalledTimes(2)
    consumeCompletion()
  })
})

describe('claim tracking', () => {
  it('marks once per process', () => {
    clearClaimTracked()
    expect(isClaimTracked()).toBe(false)
    markClaimTracked()
    expect(isClaimTracked()).toBe(true)
    clearClaimTracked()
  })
})
