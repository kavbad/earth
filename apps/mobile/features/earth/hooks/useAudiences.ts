/**
 * Who a location can be shared with (spec §75 "Share with Weekend Crew"): every group
 * conversation is an audience, and `/earth?share=<conversationId>` preselects the one a chat
 * handed off (a group, or the other person of a DM).
 */
import { type ConversationDetailDto, asConversationId, isUuid } from '@earth/domain'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { useEarthShell } from '../shell'
import { type ShareAudience, audienceForConversation, groupAudiences } from '../state/you'

export const AUDIENCES_QUERY_KEY = ['conversations', 'audiences'] as const
export const CONVERSATION_QUERY_KEY = 'conversation' as const

export interface Audiences {
  readonly audiences: readonly ShareAudience[]
  readonly loading: boolean
}

export function useShareAudiences(enabled: boolean): Audiences {
  const shell = useEarthShell()
  const { earth } = shell
  const query = useQuery({
    queryKey: [...AUDIENCES_QUERY_KEY, shell.viewerId],
    queryFn: () => earth.conversations.list({}),
    enabled: enabled && shell.ready && shell.isHuman,
    staleTime: 60_000,
  })
  const conversations = query.data?.conversations
  const audiences = useMemo(
    () => (conversations === undefined ? [] : groupAudiences(conversations)),
    [conversations],
  )
  return { audiences, loading: query.isPending && query.fetchStatus !== 'idle' }
}

/** The audience behind `/earth?share=<conversationId>`, or `null` while unknown. */
export function usePreselectedAudience(
  conversationId: string | null,
  enabled: boolean,
): ShareAudience | null {
  const shell = useEarthShell()
  const { earth } = shell
  const id = conversationId !== null && isUuid(conversationId) ? conversationId : null
  const query = useQuery({
    queryKey: [CONVERSATION_QUERY_KEY, id],
    queryFn: (): Promise<ConversationDetailDto> =>
      earth.conversations.get(asConversationId(id ?? '')),
    enabled: enabled && shell.ready && shell.isHuman && id !== null,
    staleTime: 60_000,
  })
  const detail = query.data
  const viewerId = shell.viewerId
  return useMemo(
    () => (detail === undefined ? null : audienceForConversation(detail, viewerId)),
    [detail, viewerId],
  )
}
