'use client'

import type { RoomParticipantDto } from '@earth/domain'
import { copy } from '@earth/ui'

import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { List, ListRow } from '../ui/ListRow'
import { Sheet } from '../ui/Sheet'
import { roomCopy } from './copy'
import { isModeratorRole } from './state/consent'

export interface ParticipantsSheetProps {
  readonly open: boolean
  readonly participants: readonly RoomParticipantDto[]
  readonly meId: string | null
  /** Moderator actions: remove / remove and block (SCREEN 18 "Host can remove Guest"). */
  readonly canModerate: boolean
  readonly busyId?: string | null
  readonly onRemove: (participant: RoomParticipantDto, blockFromRoom: boolean) => void
  readonly onAdmit: (participant: RoomParticipantDto) => void
  readonly onClose: () => void
}

function roleLine(participant: RoomParticipantDto): string {
  if (participant.status === 'waiting') return roomCopy.waiting
  if (participant.role === 'initiator') return roomCopy.initiator
  if (isModeratorRole(participant.role)) return roomCopy.moderator
  if (participant.mediaState === 'watching') return roomCopy.viewer
  return ''
}

/** Everyone in the room (and, for moderators, everyone waiting), with the subtle "Guest" tag. */
export function ParticipantsSheet({
  open,
  participants,
  meId,
  canModerate,
  busyId = null,
  onRemove,
  onAdmit,
  onClose,
}: ParticipantsSheetProps) {
  const visible = participants.filter(
    (p) => p.status === 'active' || (canModerate && p.status === 'waiting'),
  )
  return (
    <Sheet open={open} onClose={onClose} title={copy.roomControls.participants} closeButton>
      <List>
        {visible.map((participant) => {
          const isMe = participant.id === meId
          const line = roleLine(participant)
          const busy = busyId === participant.id
          return (
            <ListRow
              key={participant.id}
              leading={<Avatar name={participant.displayName} src={participant.avatarUrl} decorative />}
              title={
                <span className="flex items-center gap-2">
                  <span className="truncate">{participant.displayName}</span>
                  {participant.isGuest ? <span className="text-meta text-text-secondary">{copy.guest}</span> : null}
                  {isMe ? <span className="text-meta text-text-secondary">{roomCopy.you}</span> : null}
                </span>
              }
              subtitle={line === '' ? undefined : line}
              trailing={
                canModerate && !isMe ? (
                  <span className="flex items-center gap-1">
                    {participant.status === 'waiting' ? (
                      <Button variant="secondary" loading={busy} onClick={() => onAdmit(participant)}>
                        {roomCopy.admit}
                      </Button>
                    ) : null}
                    <Button variant="quiet" loading={busy} onClick={() => onRemove(participant, false)}>
                      {copy.safety.remove}
                    </Button>
                    <button
                      type="button"
                      aria-label={`${roomCopy.blockFromRoom}: ${participant.displayName}`}
                      disabled={busy}
                      onClick={() => onRemove(participant, true)}
                      className="min-h-touch-target rounded-medium px-2 text-secondary text-danger hover:bg-subtle-fill disabled:opacity-50"
                    >
                      {copy.safety.block}
                    </button>
                  </span>
                ) : undefined
              }
              className="px-0"
            />
          )
        })}
      </List>
    </Sheet>
  )
}
