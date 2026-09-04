'use client'

/**
 * SCREEN 14 group context: the group's existing conversation in a lightweight drawer — read and
 * send through `earth.conversations.messages`. Not a separate Live chat (spec: "Do not create a
 * separate public-Live chat for group-only rooms"). The chats surface owns the full experience;
 * this is the smallest faithful window onto it.
 */
import { type ConversationDetailDto, type GroupId, type MessageDto } from '@earth/domain'
import { copy } from '@earth/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type FormEvent, useState } from 'react'

import { webCopy } from '../../lib/copy'
import { useAnalytics } from '../../lib/providers/AnalyticsProvider'
import { useEarth, useRuntime } from '../../lib/providers/RuntimeProvider'
import { useSession } from '../../lib/providers/SessionProvider'
import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { Skeleton } from '../ui/Skeleton'
import { FIELD_INPUT_CLASS } from '../ui/TextField'
import { cx } from '../ui/cx'
import { roomCopy } from './copy'

export interface GroupChatDrawerProps {
  readonly open: boolean
  readonly groupId: GroupId
  readonly title: string
  readonly onClose: () => void
}

const REFRESH_INTERVAL_MS = 4_000
const PAGE_SIZE = 50

function messageLine(message: MessageDto): string {
  if (message.deletedAt !== null) return ''
  if (message.type === 'text') return message.text ?? ''
  return message.text ?? `[${message.type}]`
}

function DrawerBody({ groupId }: { groupId: GroupId }) {
  const earth = useEarth()
  const { runtime } = useRuntime()
  const session = useSession()
  const analytics = useAnalytics()
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')

  const group = useQuery({
    queryKey: ['rooms', 'group', groupId],
    queryFn: () => earth.groups.get(groupId),
    enabled: runtime !== null,
    staleTime: 5 * 60_000,
  })
  const conversationId = group.data?.conversationId ?? null
  const conversation = useQuery<ConversationDetailDto>({
    queryKey: ['rooms', 'conversation', conversationId],
    queryFn: () => earth.conversations.get(conversationId!),
    enabled: conversationId !== null,
    staleTime: 60_000,
  })
  const messages = useQuery({
    queryKey: ['rooms', 'messages', conversationId],
    queryFn: () =>
      earth.conversations.messages.list({ conversationId: conversationId!, limit: PAGE_SIZE }),
    enabled: conversationId !== null,
    refetchInterval: REFRESH_INTERVAL_MS,
  })
  const send = useMutation({
    mutationFn: (text: string) =>
      earth.conversations.messages.send({
        conversationId: conversationId!,
        clientId: crypto.randomUUID(),
        type: 'text',
        text,
        payload: {},
        replyToMessageId: null,
      }),
    onSettled: (_data, error) => {
      if (conversationId !== null) {
        analytics.track('message_sent', {
          conversationId,
          conversationType: 'group',
          groupId,
          type: 'text',
          isReply: false,
          outcome: error === null ? 'sent' : 'failed',
        })
      }
      void queryClient.invalidateQueries({ queryKey: ['rooms', 'messages', conversationId] })
    },
  })

  const members = new Map((conversation.data?.members ?? []).map((m) => [m.humanId, m]))
  const ordered = [...(messages.data?.messages ?? [])].reverse().filter((m) => m.deletedAt === null)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const text = draft.trim()
    if (text.length === 0 || conversationId === null || send.isPending) return
    setDraft('')
    send.mutate(text)
  }

  return (
    <div className="flex max-h-[60dvh] flex-col gap-3">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        {messages.isPending && ordered.length === 0 ? (
          <>
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
          </>
        ) : null}
        {messages.isError && ordered.length === 0 ? (
          <p role="status" className="text-secondary text-text-secondary">
            {copy.couldntRefresh}
          </p>
        ) : null}
        {!messages.isPending && !messages.isError && ordered.length === 0 ? (
          <p className="text-secondary text-text-secondary">{roomCopy.noMessagesYet}</p>
        ) : null}
        {ordered.map((message) => {
          const sender = members.get(message.senderHumanId)
          const mine = message.senderHumanId === session.humanId
          const name = sender?.displayName ?? roomCopy.someone
          return (
            <div
              key={message.id}
              className={cx('flex items-start gap-2', mine && 'flex-row-reverse')}
            >
              <Avatar name={name} src={sender?.avatarUrl ?? null} size="small" decorative />
              <div className={cx('flex max-w-[80%] flex-col', mine && 'items-end')}>
                <span className="text-meta text-text-secondary">{mine ? roomCopy.you : name}</span>
                <p
                  className={cx(
                    'rounded-medium px-3 py-2 text-body',
                    mine ? 'bg-text-primary text-background' : 'bg-subtle-fill',
                  )}
                >
                  {messageLine(message)}
                </p>
              </div>
            </div>
          )
        })}
      </div>
      <form onSubmit={submit} className="flex items-center gap-2">
        <label htmlFor="room-group-message" className="sr-only">
          {copy.messagePlaceholder}
        </label>
        <input
          id="room-group-message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={copy.messagePlaceholder}
          autoComplete="off"
          disabled={conversationId === null}
          className={FIELD_INPUT_CLASS}
        />
        <Button
          type="submit"
          variant="primary"
          loading={send.isPending}
          disabled={draft.trim().length === 0}
        >
          {roomCopy.send}
        </Button>
      </form>
      {send.isError ? (
        <p role="alert" className="text-secondary text-danger">
          {webCopy.somethingWrong}
        </p>
      ) : null}
    </div>
  )
}

export function GroupChatDrawer({ open, groupId, title, onClose }: GroupChatDrawerProps) {
  return (
    <Sheet open={open} onClose={onClose} title={title} closeButton>
      {open ? <DrawerBody groupId={groupId} /> : null}
    </Sheet>
  )
}
