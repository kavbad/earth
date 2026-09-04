/**
 * Everyone in the room (and, for moderators, everyone waiting), with the subtle "Guest" tag.
 * Every row but your own carries Report (spec §81 "Every Human profile: ... Report" and "Every
 * Guest: Remove, report, block session/device from room"); Remove and block-from-room stay with
 * the moderator.
 */
import type { ReportTargetType, RoomParticipantDto } from '@earth/domain'
import { copy, space } from '@earth/ui'
import { ScrollView, StyleSheet, View } from 'react-native'

import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { ListRow } from '@/components/ui/ListRow'
import { Sheet } from '@/components/ui/Sheet'
import { roomCopy } from '@/features/rooms/copy'
import { isModeratorRole } from '@/features/rooms/state/consent'

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

/** Title of the report sheet when it was opened for one person rather than for the room. */
export function reportPersonTitle(displayName: string): string {
  return `${copy.safety.report} ${displayName}`
}

function roleLine(participant: RoomParticipantDto): string {
  if (participant.status === 'waiting') return roomCopy.waiting
  if (participant.role === 'initiator') return roomCopy.initiator
  if (isModeratorRole(participant.role)) return roomCopy.moderator
  if (participant.mediaState === 'watching') return roomCopy.viewer
  return ''
}

function titleFor(participant: RoomParticipantDto, isMe: boolean): string {
  const tags: string[] = []
  if (participant.isGuest) tags.push(copy.guest)
  if (isMe) tags.push(roomCopy.you)
  return tags.length === 0
    ? participant.displayName
    : `${participant.displayName} · ${tags.join(' · ')}`
}

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
    (participant) =>
      participant.status === 'active' || (canModerate && participant.status === 'waiting'),
  )
  return (
    <Sheet open={open} onClose={onClose} title={copy.roomControls.participants} closeButton>
      <ScrollView style={styles.list} bounces={false}>
        {visible.map((participant) => {
          const isMe = participant.id === meId
          const line = roleLine(participant)
          const busy = busyId === participant.id
          return (
            <ListRow
              key={participant.id}
              flush
              leading={
                <Avatar name={participant.displayName} src={participant.avatarUrl} decorative />
              }
              title={titleFor(participant, isMe)}
              subtitle={line === '' ? undefined : line}
              trailing={
                isMe ? undefined : (
                  <View style={styles.actions}>
                    {canModerate && participant.status === 'waiting' ? (
                      <Button
                        variant="secondary"
                        compact
                        loading={busy}
                        label={roomCopy.admit}
                        onPress={() => onAdmit(participant)}
                      />
                    ) : null}
                    {canModerate ? (
                      <Button
                        variant="quiet"
                        compact
                        loading={busy}
                        label={copy.safety.remove}
                        onPress={() => onRemove(participant, false)}
                      />
                    ) : null}
                    {reportTargetForParticipant(participant) === null ? null : (
                      <Button
                        variant="quiet"
                        compact
                        disabled={busy}
                        label={copy.safety.report}
                        accessibilityLabel={`${copy.safety.report}: ${participant.displayName}`}
                        onPress={() => onReport(participant)}
                      />
                    )}
                    {canModerate ? (
                      <Button
                        variant="destructive"
                        compact
                        disabled={busy}
                        label={copy.safety.block}
                        accessibilityLabel={`${roomCopy.blockFromRoom}: ${participant.displayName}`}
                        onPress={() => onRemove(participant, true)}
                      />
                    ) : null}
                  </View>
                )
              }
            />
          )
        })}
      </ScrollView>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  list: { maxHeight: 420 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space[1] },
})
