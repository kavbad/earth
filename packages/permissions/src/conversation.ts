/**
 * Conversations and messages — mirror of `earth.can_view_conversation` (migration 0260, the
 * `messages` / `message_reactions` select policies) and `earth.assert_conversation_access` used
 * by `message_send` (migration 0270). DB_API §2; spec §26, §56.
 *
 * Members read and write; in a direct conversation a block in either direction suppresses both
 * (spec §56). Group conversations coexist with blocks: membership is not friendship and a block
 * removes nobody from a shared group.
 */
import {
  allow,
  assertHumanFailure,
  deny,
  type ConversationInput,
  type PermissionDecision,
  type Viewer,
} from './types'

function isBlockedDirect(viewer: Viewer, conversation: ConversationInput): boolean {
  return conversation.conversationType === 'direct' && viewer.blockedEitherWay
}

/** Whether the viewer may read the conversation and its messages. */
export function canReadConversation(viewer: Viewer, conversation: ConversationInput): boolean {
  if (viewer.kind === 'service') return true
  if (viewer.kind !== 'human') return false
  if (viewer.isConversationMember !== true) return false
  return !isBlockedDirect(viewer, conversation)
}

/** Whether `message_send` would accept a message from the viewer, else the error it raises. */
export function canSendMessage(
  viewer: Viewer,
  conversation: ConversationInput,
): PermissionDecision {
  const failure = assertHumanFailure(viewer.kind)
  if (failure !== null) return deny(failure)
  if (viewer.isConversationMember !== true) return deny('conversation_not_found')
  if (isBlockedDirect(viewer, conversation)) return deny('blocked')
  return allow()
}
