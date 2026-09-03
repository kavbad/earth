'use client'

import { isUuid, asConversationId } from '@earth/domain'
import { copy } from '@earth/ui'
import { useParams } from 'next/navigation'

import { ConversationScreen } from '../../../../components/chats/ConversationScreen'
import { chatCopy } from '../../../../components/chats/copy'
import { PageContainer } from '../../../../components/shell/PageContainer'
import { ScreenHeader } from '../../../../components/shell/ScreenHeader'
import { EmptyState } from '../../../../components/ui/EmptyState'

/** SCREEN 10 / 11 — a conversation. Keyed by id so moving between chats remounts the thread. */
export default function ConversationPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  if (!isUuid(id)) {
    return (
      <>
        <ScreenHeader title={copy.chats} />
        <PageContainer>
          <EmptyState title={chatCopy.conversationUnavailable} />
        </PageContainer>
      </>
    )
  }
  return <ConversationScreen key={id} conversationId={asConversationId(id)} />
}
