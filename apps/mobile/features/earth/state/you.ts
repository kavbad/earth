/**
 * SCREEN 24 helpers, pure: own posts out of the Friends feed (the pool includes the viewer's own
 * posts, DB_API §4) and the share audience a chat hands off with `/earth?share=<conversationId>`.
 */
import type {
  ConversationDetailDto,
  ConversationSummaryDto,
  FeedPostCardDto,
  LocationAudienceType,
} from '@earth/domain'

export function ownPosts(
  cards: readonly { readonly kind: string }[],
  humanId: string | null,
): FeedPostCardDto[] {
  if (humanId === null) return []
  return cards.filter(
    (card): card is FeedPostCardDto =>
      card.kind === 'post' && (card as FeedPostCardDto).author.humanId === humanId,
  )
}

export interface ShareAudience {
  readonly type: LocationAudienceType
  readonly id: string
  readonly name: string
}

/** The audience a chat hands off with `/earth?share=<conversationId>` (spec §75 "Share with Weekend Crew"). */
export function audienceForConversation(
  conversation: ConversationDetailDto,
  viewerHumanId: string | null,
): ShareAudience | null {
  if (conversation.groupId !== null)
    return { type: 'group', id: conversation.groupId, name: conversation.title }
  const other = conversation.members.find((member) => member.humanId !== viewerHumanId)
  if (other === undefined) return null
  return { type: 'friend', id: other.humanId, name: other.displayName }
}

/** Every group conversation is a place to share with (spec §75). */
export function groupAudiences(conversations: readonly ConversationSummaryDto[]): ShareAudience[] {
  const out: ShareAudience[] = []
  for (const conversation of conversations) {
    if (conversation.groupId === null) continue
    out.push({ type: 'group', id: conversation.groupId, name: conversation.title })
  }
  return out
}
