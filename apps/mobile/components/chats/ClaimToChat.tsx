/**
 * What a Visitor sees on a chats screen (spec §43): the one true line and the way in — the
 * shell's claim sheet ("Claim your place to join the conversation.").
 */
import { copy } from '@earth/ui'

import { Button, EmptyState } from '@/components/ui'
import { useChatsShell } from '@/features/chats/shell'

export function ClaimToChat({ title }: { readonly title: string }) {
  const { openClaim } = useChatsShell()
  return (
    <EmptyState
      title={title}
      body={copy.claimToJoinConversation}
      action={<Button label={copy.claimYourPlace} onPress={() => openClaim()} />}
    />
  )
}
