'use client'

import { type LiveCardDto, discoveryScopeForVisibility } from '@earth/domain'
import { namesWithPlus } from '@earth/ui'
import Link from 'next/link'

import { roomRoute } from '../rooms/routes'
import { FaceStack, type FaceStackPerson } from '../ui/FaceStack'
import { LiveMark } from '../ui/LiveMark'
import { useCardImpression } from './useCardImpression'

export interface LiveCardProps {
  readonly card: LiveCardDto
  readonly onSeen: () => void
  readonly onOpen: () => void
}

export function cardFaces(card: LiveCardDto): FaceStackPerson[] {
  return card.participantNames.map((displayName, index) => ({
    displayName,
    avatarUrl: card.participantAvatars[index] ?? null,
  }))
}

/** The second line: the context when the title already names people, the area for public Lives. */
export function cardContextLine(card: LiveCardDto): string {
  const parts: string[] = []
  if (card.contextTitle !== null && !card.title.startsWith(card.contextTitle)) parts.push(card.contextTitle)
  const scope = discoveryScopeForVisibility(card.visibility)
  if (card.areaName !== null && scope !== null && scope !== 'friends') parts.push(card.areaName)
  return parts.join(' · ')
}

/**
 * SCREEN 13 card: faces, participant-aware title from the server, context, the small Live mark —
 * no autoplay, no coloured border, no thick card. The whole row opens the room (spec §95 motion:
 * the card expands into the room).
 */
export function LiveCard({ card, onSeen, onOpen }: LiveCardProps) {
  const ref = useCardImpression(onSeen)
  const faces = cardFaces(card)
  const context = cardContextLine(card)
  return (
    <Link
      ref={ref}
      href={roomRoute(card.roomId)}
      onClick={onOpen}
      className="flex min-h-touch-target items-center gap-3 rounded-medium px-screen-margin py-3 transition-colors duration-fast ease-standard hover:bg-subtle-fill"
    >
      {faces.length > 0 ? (
        <FaceStack
          people={faces}
          total={card.participantCount}
          size="medium"
          label={namesWithPlus(card.participantNames, { total: card.participantCount })}
        />
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body font-medium text-text-primary">{card.title}</span>
        {context !== '' ? <span className="truncate text-secondary text-text-secondary">{context}</span> : null}
      </span>
      <LiveMark />
    </Link>
  )
}
