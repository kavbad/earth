/**
 * The "more" sheet of a post (spec §81 mandatory controls): Report, Hide, Block author — and
 * Delete for the author. Destructive steps confirm inside the sheet, never with a system alert.
 */
import type { PostViewDto, ReportReason } from '@earth/domain'
import { copy, space } from '@earth/ui'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { feedCopy, postCopy } from '@/features/feed/copy'

import { Button, ListRow, Sheet, text } from '@/components/ui'
import { ReportSheet } from './ReportSheet'

type Step = 'menu' | 'report' | 'block' | 'delete'

export interface PostMoreSheetProps {
  readonly open: boolean
  readonly view: PostViewDto
  readonly isOwn: boolean
  readonly busy: boolean
  readonly onReport: (reason: ReportReason) => Promise<boolean>
  readonly onHide: () => Promise<boolean>
  readonly onBlock: () => Promise<boolean>
  readonly onDelete: () => Promise<boolean>
  readonly onClose: () => void
}

export function PostMoreSheet(props: PostMoreSheetProps) {
  const [step, setStep] = useState<Step>('menu')
  const [reported, setReported] = useState(false)
  const close = () => {
    setStep('menu')
    setReported(false)
    props.onClose()
  }
  const finish = async (work: () => Promise<boolean>) => {
    const ok = await work()
    if (ok) close()
  }

  if (step === 'report') {
    return (
      <ReportSheet
        open={props.open}
        title={postCopy.reportTitle}
        sentText={postCopy.reportSent}
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

  const confirming = step === 'block' || step === 'delete'
  return (
    <Sheet open={props.open} onClose={close} title={postCopy.postActions} closeButton>
      {confirming ? (
        <View style={styles.stack}>
          <Text style={[text.body, text.primary]}>
            {step === 'block'
              ? postCopy.blockConfirm(props.view.author.displayName)
              : postCopy.deleteConfirm}
          </Text>
          {step === 'block' ? (
            <Text style={[text.secondary, text.muted]}>{postCopy.blockBody}</Text>
          ) : null}
          <View style={styles.actions}>
            <Button
              variant="destructive"
              fullWidth
              loading={props.busy}
              label={step === 'block' ? copy.safety.block : postCopy.deletePost}
              onPress={() => void finish(step === 'block' ? props.onBlock : props.onDelete)}
            />
            <Button variant="quiet" fullWidth label={copy.notNow} onPress={() => setStep('menu')} />
          </View>
        </View>
      ) : (
        <View style={styles.stack}>
          <View>
            <ListRow title={copy.safety.report} onPress={() => setStep('report')} flush />
            {props.isOwn ? (
              <ListRow
                title={postCopy.deletePost}
                onPress={() => setStep('delete')}
                flush
                destructive
                separator={false}
              />
            ) : (
              <>
                <ListRow
                  title={copy.safety.hide}
                  disabled={props.busy}
                  onPress={() => void finish(props.onHide)}
                  flush
                />
                <ListRow
                  title={copy.safety.blockAuthor}
                  onPress={() => setStep('block')}
                  flush
                  destructive
                  separator={false}
                />
              </>
            )}
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
