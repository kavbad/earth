'use client'

import type { ReportTargetType, RoomParticipantDto } from '@earth/domain'
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
  /** Spec §81: everyone in the room may report anyone else in it, Human or Guest. */
  readonly onReport: (participant: RoomParticipantDto) => void
  readonly onClose: () => void
}

/**
 * What this participant's Report sends to `report_create` (spec §81, DB_API §7): a Human is
 * reported by `humanId`, a Guest by the id of their guest session. `null` for a row that carries
 * neither — the schema forbids it, so the action is simply not offered.
 */
export function reportTargetForParticipant(
  participant: RoomParticipantDto,
): { readonly type: Extract<ReportTargetType, 'human' | 'guest'>; readonly id: string } | null {
  if (participant.isGuest) {
    return participant.guestSessionId === null
      ? null
      : { type: 'guest', id: participant.guestSessionId }
  }
  return participant.humanId === null ? null : { type: 'human', id: participant.humanId }
}

function roleLine(participant: RoomParticipantDto): string {
  if (participant.status === 'waiting') return roomCopy.waiting
  if (participant.role === 'initiator') return roomCopy.initiator
  if (isModeratorRole(participant.role)) return roomCopy.moderator
  if (participant.mediaState === 'watching') return roomCopy.viewer
  return ''
}

/**
 * Everyone in the room (and, for moderators, everyone waiting), with the subtle "Guest" tag.
 * Every row but your own carries Report (spec §81 "Every Human profile: ... Report" and "Every
 * Guest: Remove, report, block session/device from room"); Remove and block-from-room stay with
 * the moderator.
 */
export function ParticipantsSheet({
  open,
  participants,
  meId,
  canModerate,
  busyId = null,
  onRemove,
  onAdmit,
  onReport,
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
              leading={
                <Avatar name={participant.displayName} src={participant.avatarUrl} decorative />
              }
              title={
                <span className="flex items-center gap-2">
                  <span className="truncate">{participant.displayName}</span>
                  {participant.isGuest ? (
                    <span className="text-meta text-text-secondary">{copy.guest}</span>
                  ) : null}
                  {isMe ? (
                    <span className="text-meta text-text-secondary">{roomCopy.you}</span>
                  ) : null}
                </span>
              }
              subtitle={line === '' ? undefined : line}
              trailing={
                isMe ? undefined : (
                  <span className="flex items-center gap-1">
                    {canModerate && participant.status === 'waiting' ? (
                      <Button
                        variant="secondary"
                        loading={busy}
                        onClick={() => onAdmit(participant)}
                      >
                        {roomCopy.admit}
                      </Button>
                    ) : null}
                    {canModerate ? (
                      <Button
                        variant="quiet"
                        loading={busy}
                        onClick={() => onRemove(participant, false)}
                      >
                        {copy.safety.remove}
                      </Button>
                    ) : null}
                    {reportTargetForParticipant(participant) === null ? null : (
                      <button
                        type="button"
                        aria-label={`${copy.safety.report}: ${participant.displayName}`}
                        disabled={busy}
                        onClick={() => onReport(participant)}
                        className="min-h-touch-target rounded-medium px-2 text-secondary text-text-secondary hover:bg-subtle-fill disabled:opacity-50"
                      >
                        {copy.safety.report}
                      </button>
                    )}
                    {canModerate ? (
                      <button
                        type="button"
                        aria-label={`${roomCopy.blockFromRoom}: ${participant.displayName}`}
                        disabled={busy}
                        onClick={() => onRemove(participant, true)}
                        className="min-h-touch-target rounded-medium px-2 text-secondary text-danger hover:bg-subtle-fill disabled:opacity-50"
                      >
                        {copy.safety.block}
                      </button>
                    ) : null}
                  </span>
                )
              }
              className="px-0"
            />
          )
        })}
      </List>
    </Sheet>
  )
}
