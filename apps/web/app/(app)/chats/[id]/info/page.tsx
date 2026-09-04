'use client'

import { asConversationId, isUuid } from '@earth/domain'
import { useParams } from 'next/navigation'

import { ConversationInfo } from '../../../../../components/chats/ConversationInfo'
import { chatCopy } from '../../../../../components/chats/copy'
import { PageContainer } from '../../../../../components/shell/PageContainer'
import { ScreenHeader } from '../../../../../components/shell/ScreenHeader'
import { EmptyState } from '../../../../../components/ui/EmptyState'

/** SCREEN 12 — Group info (and the DM counterpart). */
export default function ConversationInfoPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  if (!isUuid(id)) {
    return (
      <>
        <ScreenHeader title={chatCopy.info} />
        <PageContainer>
          <EmptyState title={chatCopy.conversationUnavailable} />
        </PageContainer>
      </>
    )
  }
  return <ConversationInfo key={id} conversationId={asConversationId(id)} />
}
