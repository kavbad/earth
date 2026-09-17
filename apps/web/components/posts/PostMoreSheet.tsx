'use client'

/**
 * The "more" sheet of a post (spec §81 mandatory controls): Report, Hide, Block author — and
 * Delete for the author. Destructive steps confirm inside the sheet, never with a browser alert.
 */
import type { PostViewDto, ReportReason } from '@earth/domain'
import { copy } from '@earth/ui'
import { useState } from 'react'

import { webCopy } from '../../lib/copy'
import { Button } from '../ui/Button'
import { List, ListRow } from '../ui/ListRow'
import { Sheet } from '../ui/Sheet'
import { ReportSheet } from './ReportSheet'
import { postCopy } from './copy'

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
        <div className="flex flex-col gap-4">
          <p className="text-body">
            {step === 'block'
              ? postCopy.blockConfirm(props.view.author.displayName)
              : postCopy.deleteConfirm}
          </p>
          {step === 'block' ? (
            <p className="text-secondary text-text-secondary">{postCopy.blockBody}</p>
          ) : null}
          <div className="flex flex-col gap-2">
            <Button
              variant="destructive"
              fullWidth
              loading={props.busy}
              onClick={() => void finish(step === 'block' ? props.onBlock : props.onDelete)}
            >
              {step === 'block' ? copy.safety.block : postCopy.deletePost}
            </Button>
            <Button variant="quiet" fullWidth onClick={() => setStep('menu')}>
              {copy.notNow}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <List>
            <ListRow
              as="button"
              title={copy.safety.report}
              onClick={() => setStep('report')}
              className="px-0"
            />
            {props.isOwn ? (
              <ListRow
                as="button"
                title={postCopy.deletePost}
                onClick={() => setStep('delete')}
                className="px-0"
              />
            ) : (
              <>
                <ListRow
                  as="button"
                  title={copy.safety.hide}
                  disabled={props.busy}
                  onClick={() => void finish(props.onHide)}
                  className="px-0"
                />
                <ListRow
                  as="button"
                  title={copy.safety.blockAuthor}
                  onClick={() => setStep('block')}
                  className="px-0"
                />
              </>
            )}
          </List>
          <Button variant="quiet" fullWidth onClick={close}>
            {webCopy.close}
          </Button>
        </div>
      )}
    </Sheet>
  )
}
