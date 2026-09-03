'use client'

/**
 * SCREEN 23 row: actor faces, title, body, time. Unread rows read heavier; a friend request can
 * be accepted in place. Tapping goes where the notification points (room, conversation, profile).
 */
import type { HumanId } from '@earth/domain'
import { copy, relativeTime } from '@earth/ui'
import Link from 'next/link'
import type { Route } from 'next'
import type { ReactNode } from 'react'

import { conversationRoute } from '../../../lib/routes'
import { profileRoute, searchRoute } from '../../profile/routes'
import { roomRoute } from '../../rooms/routes'
import { useCardImpression } from '../../live/useCardImpression'
import { Avatar } from '../../ui/Avatar'
import { Button } from '../../ui/Button'
import { FaceStack } from '../../ui/FaceStack'
import { LiveMark } from '../../ui/LiveMark'
import { cx } from '../../ui/cx'
import { feedCopy } from '../copy'
import type { NotificationDestination, NotificationRow as Row } from './state/rows'

export function destinationRoute(destination: NotificationDestination): Route | null {
  switch (destination.kind) {
    case 'room':
      return roomRoute(destination.roomId)
    case 'conversation':
      return conversationRoute(destination.conversationId)
    case 'profile':
      return profileRoute(destination.handle)
    case 'search':
      return searchRoute(destination.query)
    case 'none':
      return null
  }
}

export interface NotificationRowProps {
  readonly row: Row
  /** Reported when the row is on screen (mark read on view). */
  readonly onSeen: () => void
  readonly onAccept: (row: Row, actorHumanId: HumanId) => Promise<boolean>
  readonly onOpen: (row: Row) => void
}

const ROW_CLASS =
  'flex min-h-touch-target items-start gap-3 px-screen-margin py-3 text-left transition-colors duration-fast ease-standard'

export function NotificationRow({ row, onSeen, onAccept, onOpen }: NotificationRowProps) {
  const actorHumanId = row.actorHumanId
  const ref = useCardImpression(onSeen)
  const href = destinationRoute(row.destination)
  const isLive =
    row.type === 'friend_live' || row.type === 'multi_live' || row.type === 'group_live'
  const first = row.faces[0]

  const faces: ReactNode =
    row.faces.length > 1 ? (
      <FaceStack
        people={row.faces}
        size="medium"
        label={row.faces.map((face) => face.displayName).join(', ')}
      />
    ) : first !== undefined ? (
      <Avatar name={first.displayName} src={first.avatarUrl} decorative live={isLive} />
    ) : (
      <span aria-hidden="true" className="size-10 rounded-avatar bg-subtle-fill" />
    )

  const body = (
    <>
      <span className="shrink-0 pt-0.5">{faces}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cx(
            'text-body',
            row.unread ? 'font-medium text-text-primary' : 'text-text-primary',
          )}
        >
          {row.title}
          {row.unread ? <span className="sr-only"> · {feedCopy.unread}</span> : null}
        </span>
        {row.body !== '' ? (
          <span className="truncate text-secondary text-text-secondary">{row.body}</span>
        ) : null}
        <span className="mt-0.5 inline-flex items-center gap-2 text-meta text-text-secondary">
          {isLive ? <LiveMark /> : null}
          <span>{relativeTime(row.createdAt)}</span>
        </span>
      </span>
      {row.unread ? (
        <span aria-hidden="true" className="mt-2 size-2 shrink-0 rounded-avatar bg-earth-accent" />
      ) : null}
    </>
  )

  const accept =
    row.acceptable && actorHumanId !== null ? (
      <div className="flex shrink-0 items-center self-center">
        <Button
          variant="primary"
          className="min-h-10 px-4 text-secondary"
          onClick={() => void onAccept(row, actorHumanId)}
        >
          {feedCopy.accept}
        </Button>
      </div>
    ) : null

  return (
    <div ref={ref} className={cx('flex items-stretch', row.unread && 'bg-subtle-fill/60')}>
      {href === null ? (
        <div className={cx(ROW_CLASS, 'flex-1')}>{body}</div>
      ) : (
        <Link
          href={href}
          onClick={() => onOpen(row)}
          className={cx(ROW_CLASS, 'flex-1 hover:bg-subtle-fill')}
          aria-label={copy.notificationLine({ title: row.title, body: row.body })}
        >
          {body}
        </Link>
      )}
      {accept !== null ? <div className="pr-screen-margin">{accept}</div> : null}
    </div>
  )
}
