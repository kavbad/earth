/** Everyone in the room (and, for moderators, everyone waiting), with the subtle "Guest" tag. */
import type { RoomParticipantDto } from '@earth/domain'
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
  readonly onClose: () => void
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
                canModerate && !isMe ? (
                  <View style={styles.actions}>
                    {participant.status === 'waiting' ? (
                      <Button
                        variant="secondary"
                        compact
                        loading={busy}
                        label={roomCopy.admit}
                        onPress={() => onAdmit(participant)}
                      />
                    ) : null}
                    <Button
                      variant="quiet"
                      compact
                      loading={busy}
                      label={copy.safety.remove}
                      onPress={() => onRemove(participant, false)}
                    />
                    <Button
                      variant="destructive"
                      compact
                      disabled={busy}
                      label={copy.safety.block}
                      accessibilityLabel={`${roomCopy.blockFromRoom}: ${participant.displayName}`}
                      onPress={() => onRemove(participant, true)}
                    />
                  </View>
                ) : undefined
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
