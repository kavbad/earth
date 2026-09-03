'use client'

import { REPORT_REASON, type ReportReason } from '@earth/domain'
import { copy } from '@earth/ui'

import { Button } from '../ui/Button'
import { List, ListRow } from '../ui/ListRow'
import { Sheet } from '../ui/Sheet'
import { roomCopy } from './copy'

export interface ReportSheetProps {
  readonly open: boolean
  readonly busy?: boolean
  readonly done?: boolean
  readonly onReport: (reason: ReportReason) => void
  readonly onClose: () => void
}

/** Spec §82 reasons, exact labels from `@earth/ui`, one tap each. */
export function ReportSheet({ open, busy = false, done = false, onReport, onClose }: ReportSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title={roomCopy.reportTitle} closeButton>
      {done ? (
        <div className="flex flex-col gap-4">
          <p role="status" className="text-body">
            {roomCopy.reportSent}
          </p>
          <Button variant="quiet" fullWidth onClick={onClose}>
            {copy.done}
          </Button>
        </div>
      ) : (
        <List>
          {REPORT_REASON.map((reason) => (
            <ListRow
              key={reason}
              as="button"
              title={copy.reportReasons[reason]}
              disabled={busy}
              onClick={() => onReport(reason)}
              className="px-0"
            />
          ))}
        </List>
      )}
    </Sheet>
  )
}
