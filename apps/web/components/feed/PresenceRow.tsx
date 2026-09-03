'use client'

/**
 * SCREEN 02 presence row: "Xavier + Maya live", "Weekend Crew · 3 active", "Sarah nearby" —
 * rendered only with meaningful state (the caller passes nothing otherwise). Live items carry
 * the small live dot and faces; a room opens the room, a group its conversation.
 */
import type { PresenceItemDto } from '@earth/domain'
import Link from 'next/link'
import type { ReactNode } from 'react'

import { conversationRoute } from '../../lib/routes'
import { roomRoute } from '../rooms/routes'
import { FaceStack } from '../ui/FaceStack'
import { LiveMark } from '../ui/LiveMark'
import { cx } from '../ui/cx'
import { feedCopy } from './copy'

export interface PresenceRowProps {
  readonly items: readonly PresenceItemDto[]
  readonly className?: string | undefined
}

const CHIP_CLASS =
  'inline-flex min-h-touch-target shrink-0 items-center gap-2 rounded-medium px-2 text-secondary text-text-primary transition-colors duration-fast ease-standard'

function PresenceChip({ item }: { item: PresenceItemDto }) {
  const faces = item.avatarUrls.map((avatarUrl) => ({ displayName: item.label, avatarUrl }))
  const content: ReactNode = (
    <>
      {faces.length > 0 ? <FaceStack people={faces} size="small" label={item.label} /> : null}
      {item.type === 'friends_live' ? <LiveMark text={false} /> : null}
      <span className="truncate">{item.label}</span>
    </>
  )
  if (item.roomId !== null) {
    return (
      <Link href={roomRoute(item.roomId)} className={cx(CHIP_CLASS, 'hover:bg-subtle-fill')}>
        {content}
      </Link>
    )
  }
  if (item.conversationId !== null) {
    return (
      <Link
        href={conversationRoute(item.conversationId)}
        className={cx(CHIP_CLASS, 'hover:bg-subtle-fill')}
      >
        {content}
      </Link>
    )
  }
  return <span className={CHIP_CLASS}>{content}</span>
}

export function PresenceRow({ items, className }: PresenceRowProps) {
  if (items.length === 0) return null
  return (
    <div
      role="list"
      aria-label={feedCopy.presenceLabel}
      className={cx(
        '-mx-2 flex items-center gap-1 overflow-x-auto px-2 [scrollbar-width:none]',
        className,
      )}
    >
      {items.map((item, index) => (
        <div role="listitem" key={`${item.type}-${item.roomId ?? item.conversationId ?? index}`}>
          <PresenceChip item={item} />
        </div>
      ))}
    </div>
  )
}
