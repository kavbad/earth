/**
 * SCREEN 22 "more": remove friend / unfollow when they apply, Block or Unblock, Report (spec §81).
 * Destructive steps confirm inside the sheet, never with a system alert.
 */
import type { ProfileDto, ReportReason } from '@earth/domain'
import { copy, space } from '@earth/ui'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { ReportSheet } from '@/components/posts/ReportSheet'
import { Button, ListRow, Sheet, text } from '@/components/ui'
import { feedCopy, profileCopy } from '@/features/feed/copy'

type Step = 'menu' | 'report' | 'block'

export interface ProfileMoreSheetProps {
  readonly open: boolean
  readonly profile: ProfileDto
  readonly busy: boolean
  readonly onRemoveFriend: () => Promise<void>
  readonly onUnfollow: () => Promise<void>
  readonly onBlock: () => Promise<void>
  readonly onUnblock: () => Promise<void>
  readonly onReport: (reason: ReportReason) => Promise<boolean>
  readonly onClose: () => void
}

export function ProfileMoreSheet(props: ProfileMoreSheetProps) {
  const [step, setStep] = useState<Step>('menu')
  const [reported, setReported] = useState(false)
  const name = props.profile.identity.displayName
  const { relationship } = props.profile
  const close = () => {
    setStep('menu')
    setReported(false)
    props.onClose()
  }
  const finish = async (work: () => Promise<void>) => {
    await work()
    close()
  }

  if (step === 'report') {
    return (
      <ReportSheet
        open={props.open}
        title={profileCopy.reportTitle(name)}
        sentText={profileCopy.reportSent}
        busy={props.busy}
        done={reported}
        onReport={(reason) => {
          void props.onReport(reason).then((ok) => {
            if (ok) setReported(true)
          })
        }}
        onClose={close}
      />
    )
  }

  const rows = [
    relationship.isFriend
      ? {
          key: 'remove',
          title: profileCopy.removeFriend,
          onPress: () => void finish(props.onRemoveFriend),
        }
      : null,
    relationship.isFollowing
      ? {
          key: 'unfollow',
          title: profileCopy.unfollow,
          onPress: () => void finish(props.onUnfollow),
        }
      : null,
    relationship.isBlocked
      ? { key: 'unblock', title: copy.safety.unblock, onPress: () => void finish(props.onUnblock) }
      : { key: 'block', title: copy.safety.block, onPress: () => setStep('block') },
    { key: 'report', title: copy.safety.report, onPress: () => setStep('report') },
  ].filter((row) => row !== null)

  return (
    <Sheet open={props.open} onClose={close} title={copy.profileActions.more} closeButton>
      {step === 'block' ? (
        <View style={styles.stack}>
          <Text style={[text.body, text.primary]}>{profileCopy.blockConfirm(name)}</Text>
          <Text style={[text.secondary, text.muted]}>{profileCopy.blockBody}</Text>
          <View style={styles.actions}>
            <Button
              variant="destructive"
              fullWidth
              loading={props.busy}
              label={copy.safety.block}
              onPress={() => void finish(props.onBlock)}
            />
            <Button variant="quiet" fullWidth label={copy.notNow} onPress={() => setStep('menu')} />
          </View>
        </View>
      ) : (
        <View style={styles.stack}>
          <View>
            {rows.map((row, index) => (
              <ListRow
                key={row.key}
                title={row.title}
                disabled={props.busy}
                destructive={row.key === 'block'}
                onPress={row.onPress}
                flush
                separator={index < rows.length - 1}
              />
            ))}
          </View>
          <Button variant="quiet" fullWidth label={feedCopy.close} onPress={close} />
        </View>
      )}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  stack: { gap: space[3] },
  actions: { gap: space[2] },
})
