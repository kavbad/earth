/** SCREEN 14 viewer state: "Join them" → "Join audio" / "Join on camera". */
import type { MediaState } from '@earth/domain'
import { copy, space, spacing } from '@earth/ui'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'

import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { StatusLine } from '@/components/ui/StatusLine'

export type JoinMediaState = Exclude<MediaState, 'watching'>

export interface ViewerJoinProps {
  readonly onJoin: (mediaState: JoinMediaState) => void
  /** Visitors: the tap opens the claim sheet instead (spec §43). */
  readonly onTap?: (() => boolean) | undefined
  readonly busy?: boolean
  readonly error?: string | null
}

export function ViewerJoin({ onJoin, onTap, busy = false, error = null }: ViewerJoinProps) {
  const [choosing, setChoosing] = useState(false)
  const open = () => {
    if (onTap !== undefined && !onTap()) return
    setChoosing(true)
  }
  const choose = (mediaState: JoinMediaState) => {
    setChoosing(false)
    onJoin(mediaState)
  }
  return (
    <View style={styles.bar}>
      <Button variant="primary" fullWidth loading={busy} label={copy.joinThem} onPress={open} />
      {error !== null ? <StatusLine message={error} danger /> : null}
      <Sheet open={choosing} onClose={() => setChoosing(false)} title={copy.joinThem}>
        <View style={styles.choices}>
          <Button
            variant="primary"
            fullWidth
            label={copy.joinAudio}
            onPress={() => choose('audio')}
          />
          <Button
            variant="secondary"
            fullWidth
            label={copy.joinOnCamera}
            onPress={() => choose('camera')}
          />
        </View>
      </Sheet>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: spacing.screenMargin, paddingVertical: space[3], gap: space[2] },
  choices: { gap: space[2] },
})
