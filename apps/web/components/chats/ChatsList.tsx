'use client'

/**
 * SCREEN 08 — Chats. Header "Chats" with the new-chat icon, a search field, then rows. No
 * Groups / DMs tabs. Visitors see the claim sheet; a failed refresh keeps the cached rows and
 * says "Couldn't refresh" inline.
 */
import type { ConversationSummaryDto } from '@earth/domain'
import { copy } from '@earth/ui'
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'

import { webCopy } from '../../lib/copy'
import { useSession } from '../../lib/providers/SessionProvider'
import { useClaimGate } from '../shell/ClaimSheet'
import { LoadingState } from '../shell/LoadingState'
import { PageContainer } from '../shell/PageContainer'
import { ScreenHeader } from '../shell/ScreenHeader'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Icon } from '../ui/Icon'
import { SearchField } from '../ui/SearchField'
import { List } from '../ui/ListRow'
import { Skeleton } from '../ui/Skeleton'
import { Spinner } from '../ui/Spinner'
import { ChatRow, previewLine } from './ChatRow'
import { chatCopy } from './copy'
import { useConversationsList } from './hooks/useConversationsList'
import { NEW_CHAT_ROUTE } from './routes'

/** Client-side filter of loaded rows by name and last message (SCREEN 08 "Search at top"). */
export function filterConversations(
  conversations: readonly ConversationSummaryDto[],
  query: string,
): ConversationSummaryDto[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return [...conversations]
  return conversations.filter(
    (conversation) =>
      conversation.title.toLowerCase().includes(needle) ||
      previewLine(conversation, null).toLowerCase().includes(needle),
  )
}

export function ClaimToChat({ title }: { readonly title: string }) {
  const gate = useClaimGate()
  return (
    <EmptyState
      title={title}
      body={copy.claimToJoinConversation}
      action={
        <Button variant="primary" onClick={() => gate.open('public_world')}>
          {copy.claimYourPlace}
        </Button>
      }
    />
  )
}

function ChatsSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col">
      {[0, 1, 2, 3, 4].map((index) => (
        <div key={index} className="flex items-center gap-3 px-screen-margin py-3">
          <Skeleton className="size-10 rounded-avatar" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function ChatsList() {
  const session = useSession()
  const list = useConversationsList()
  const [query, setQuery] = useState('')
  const sentinel = useRef<HTMLDivElement>(null)
  const isHuman = session.status === 'ready' && session.roleKind === 'human'
  const filtered = useMemo(
    () => filterConversations(list.conversations, query),
    [list.conversations, query],
  )

  useEffect(() => {
    const node = sentinel.current
    if (node === null || !list.hasMore || query.length > 0) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) list.loadMore()
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [list, query])

  return (
    <>
      <ScreenHeader
        title={copy.chats}
        trailing={
          isHuman ? (
            <Link
              href={NEW_CHAT_ROUTE}
              aria-label={copy.newChat}
              className="flex size-touch-target items-center justify-center rounded-avatar text-text-primary transition-colors duration-fast ease-standard hover:bg-subtle-fill"
            >
              <Icon name="plus" />
            </Link>
          ) : undefined
        }
      >
        {isHuman ? (
          <SearchField
            label={chatCopy.searchChats}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={copy.search}
          />
        ) : null}
      </ScreenHeader>
      <PageContainer>
        {session.status === 'loading' ? (
          <ChatsSkeleton />
        ) : !isHuman ? (
          <ClaimToChat title={copy.chats} />
        ) : (
          <>
            {list.error && list.conversations.length > 0 ? (
              <div
                role="status"
                className="flex items-center justify-between gap-3 px-screen-margin py-2 text-secondary text-text-secondary"
              >
                <span>{copy.couldntRefresh}</span>
                <Button variant="quiet" onClick={list.refetch}>
                  {webCopy.retry}
                </Button>
              </div>
            ) : null}
            {list.loading ? (
              <LoadingState>
                <ChatsSkeleton />
              </LoadingState>
            ) : list.error && list.conversations.length === 0 ? (
              <EmptyState
                title={copy.couldntRefresh}
                action={
                  <Button variant="secondary" onClick={list.refetch}>
                    {webCopy.retry}
                  </Button>
                }
              />
            ) : list.conversations.length === 0 ? (
              <EmptyState
                title={chatCopy.noChatsYet}
                body={copy.addPeopleYouKnow}
                action={
                  <Link
                    href={NEW_CHAT_ROUTE}
                    className="inline-flex min-h-touch-target items-center rounded-medium bg-text-primary px-5 text-body font-medium text-background"
                  >
                    {copy.newChat}
                  </Link>
                }
              />
            ) : filtered.length === 0 ? (
              <EmptyState title={chatCopy.noMatches} />
            ) : (
              <List className="fade-in">
                {filtered.map((conversation) => (
                  <ChatRow
                    key={conversation.id}
                    conversation={conversation}
                    viewerId={session.humanId}
                  />
                ))}
              </List>
            )}
            <div ref={sentinel} className="flex justify-center py-4">
              {list.loadingMore ? <Spinner /> : null}
            </div>
          </>
        )}
      </PageContainer>
    </>
  )
}
