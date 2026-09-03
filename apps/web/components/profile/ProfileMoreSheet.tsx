'use client'

import type { ProfileDto, ReportReason } from '@earth/domain'
import { copy } from '@earth/ui'
import { useState } from 'react'

import { webCopy } from '../../lib/copy'
import { ReportSheet } from '../posts/ReportSheet'
import { Button } from '../ui/Button'
import { List, ListRow } from '../ui/ListRow'
import { Sheet } from '../ui/Sheet'
import { profileCopy } from './copy'

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

/** SCREEN 22 "more": remove friend / unfollow when they apply, Block or Unblock, Report. */
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

  return (
    <Sheet open={props.open} onClose={close} title={copy.profileActions.more} closeButton>
      {step === 'block' ? (
        <div className="flex flex-col gap-4">
          <p className="text-body">{profileCopy.blockConfirm(name)}</p>
          <p className="text-secondary text-text-secondary">{profileCopy.blockBody}</p>
          <div className="flex flex-col gap-2">
            <Button
              variant="destructive"
              fullWidth
              loading={props.busy}
              onClick={() => void finish(props.onBlock)}
            >
              {copy.safety.block}
            </Button>
            <Button variant="quiet" fullWidth onClick={() => setStep('menu')}>
              {copy.notNow}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <List>
            {relationship.isFriend ? (
              <ListRow
                as="button"
                title={profileCopy.removeFriend}
                disabled={props.busy}
                onClick={() => void finish(props.onRemoveFriend)}
                className="px-0"
              />
            ) : null}
            {relationship.isFollowing ? (
              <ListRow
                as="button"
                title={profileCopy.unfollow}
                disabled={props.busy}
                onClick={() => void finish(props.onUnfollow)}
                className="px-0"
              />
            ) : null}
            {relationship.isBlocked ? (
              <ListRow
                as="button"
                title={copy.safety.unblock}
                disabled={props.busy}
                onClick={() => void finish(props.onUnblock)}
                className="px-0"
              />
            ) : (
              <ListRow
                as="button"
                title={copy.safety.block}
                onClick={() => setStep('block')}
                className="px-0"
              />
            )}
            <ListRow
              as="button"
              title={copy.safety.report}
              onClick={() => setStep('report')}
              className="px-0"
            />
          </List>
          <Button variant="quiet" fullWidth onClick={close}>
            {webCopy.close}
          </Button>
        </div>
      )}
    </Sheet>
  )
}
