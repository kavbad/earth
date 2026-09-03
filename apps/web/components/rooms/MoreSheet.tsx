'use client'

import { copy } from '@earth/ui'
import { useState } from 'react'

import { webCopy } from '../../lib/copy'
import { Button } from '../ui/Button'
import { List, ListRow } from '../ui/ListRow'
import { Sheet } from '../ui/Sheet'
import { FIELD_INPUT_CLASS } from '../ui/TextField'
import { roomCopy } from './copy'

export interface MoreSheetProps {
  readonly open: boolean
  readonly canModerate: boolean
  /** Guests get report and leave only: no invites, no room controls (SCREEN 18). */
  readonly isGuest: boolean
  readonly guestsDisabled: boolean
  /** A link that could not be copied automatically is shown for manual copying. */
  readonly shareUrl: string | null
  readonly busy?: boolean
  readonly onShare: () => void
  readonly onToggleGuests: () => void
  readonly onEnd: () => void
  readonly onReport: () => void
  readonly onLeave: () => void
  readonly onClose: () => void
}

/** The "more" sheet: share link, Guests on/off and End room for moderators, report, leave. */
export function MoreSheet(props: MoreSheetProps) {
  const [confirmingEnd, setConfirmingEnd] = useState(false)
  const close = () => {
    setConfirmingEnd(false)
    props.onClose()
  }
  return (
    <Sheet open={props.open} onClose={close} title={copy.roomControls.more} closeButton>
      {confirmingEnd ? (
        <div className="flex flex-col gap-4">
          <p className="text-body">{roomCopy.endRoomConfirm}</p>
          <div className="flex flex-col gap-2">
            <Button variant="primary" fullWidth loading={props.busy ?? false} onClick={props.onEnd}>
              {roomCopy.endRoomYes}
            </Button>
            <Button variant="quiet" fullWidth onClick={() => setConfirmingEnd(false)}>
              {copy.notNow}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {props.shareUrl !== null ? (
            <label className="flex flex-col gap-1 text-secondary text-text-secondary">
              {roomCopy.linkReady}
              <input
                readOnly
                value={props.shareUrl}
                className={FIELD_INPUT_CLASS}
                onFocus={(e) => e.currentTarget.select()}
              />
            </label>
          ) : null}
          <List>
            {!props.isGuest ? (
              <ListRow
                as="button"
                title={copy.shareLink}
                disabled={props.busy}
                onClick={props.onShare}
                className="px-0"
              />
            ) : null}
            {props.canModerate ? (
              <ListRow
                as="button"
                title={props.guestsDisabled ? roomCopy.allowGuests : copy.safety.disableGuests}
                disabled={props.busy}
                onClick={props.onToggleGuests}
                className="px-0"
              />
            ) : null}
            {props.canModerate ? (
              <ListRow
                as="button"
                title={copy.safety.endRoom}
                onClick={() => setConfirmingEnd(true)}
                className="px-0"
              />
            ) : null}
            <ListRow
              as="button"
              title={copy.safety.report}
              onClick={props.onReport}
              className="px-0"
            />
            <ListRow as="button" title={copy.leave} onClick={props.onLeave} className="px-0" />
          </List>
          <Button variant="quiet" fullWidth onClick={close}>
            {webCopy.close}
          </Button>
        </div>
      )}
    </Sheet>
  )
}
