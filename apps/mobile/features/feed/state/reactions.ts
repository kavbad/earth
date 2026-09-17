/**
 * Reactions (spec §31): one reaction per Human per post, stored as a short text. V1 has a
 * single kind; the value is a domain constant so no screen spells it.
 */
export const POST_REACTION = 'like' as const

export interface ReactionState {
  readonly reacted: boolean
  readonly count: number
}

export function reactionStateFor(input: {
  readonly myReaction: string | null
  readonly reactionCount: number
}): ReactionState {
  return { reacted: input.myReaction !== null, count: input.reactionCount }
}

/** The optimistic state after a toggle. */
export function toggledReaction(state: ReactionState): ReactionState {
  return state.reacted
    ? { reacted: false, count: Math.max(0, state.count - 1) }
    : { reacted: true, count: state.count + 1 }
}
