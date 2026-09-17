'use client'

/**
 * Report (spec §81–§82): the exact reasons in the spec's order, one tap each, then a quiet
 * confirmation. Works for every target type (`human`, `post`, `room`, `message`, `guest`,
 * `group`) and for Guests reporting their room. Tracks `content_reported` (spec §97).
 */
import type { ReportDto, ReportReason, ReportTargetType } from '@earth/domain'
import { REPORT_REASON } from '@earth/domain'
import { copy } from '@earth/ui'
import { useCallback, useState } from 'react'

import { useAnalytics } from '../../lib/providers/AnalyticsProvider'
import { useEarth } from '../../lib/providers/RuntimeProvider'
import { Button } from '../ui/Button'
import { List, ListRow } from '../ui/ListRow'
import { Sheet } from '../ui/Sheet'
import { safetyCopy } from './copy'

export interface ReportSheetViewProps {
  readonly open: boolean
  readonly title?: string
  readonly busy?: boolean
  readonly done?: boolean
  readonly error?: string | null
  readonly onReason: (reason: ReportReason) => void
  readonly onClose: () => void
}

/** Presentational sheet (no providers) — rendered by `ReportSheet`, exported for tests and reuse. */
export function ReportSheetView({
  open,
  title = safetyCopy.reportTitle,
  busy = false,
  done = false,
  error = null,
  onReason,
  onClose,
}: ReportSheetViewProps) {
  return (
    <Sheet open={open} onClose={onClose} title={title} closeButton>
      {done ? (
        <div className="flex flex-col gap-4">
          <p role="status" className="text-body">
            {safetyCopy.reportSent}
          </p>
          <Button variant="quiet" fullWidth onClick={onClose}>
            {copy.done}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <List>
            {REPORT_REASON.map((reason) => (
              <ListRow
                key={reason}
                as="button"
                title={copy.reportReasons[reason]}
                disabled={busy}
                onClick={() => onReason(reason)}
                className="px-0"
              />
            ))}
          </List>
          <p className="text-secondary text-text-secondary">{safetyCopy.reportHint}</p>
          {error !== null ? (
            <p role="alert" className="text-secondary text-danger">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Sheet>
  )
}

export interface ReportSheetProps {
  readonly open: boolean
  readonly targetType: ReportTargetType
  readonly targetId: string
  readonly title?: string
  readonly onClose: () => void
  readonly onReported?: ((report: ReportDto) => void) | undefined
}

export function ReportSheet({
  open,
  targetType,
  targetId,
  title,
  onClose,
  onReported,
}: ReportSheetProps) {
  const earth = useEarth()
  const analytics = useAnalytics()
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = useCallback(() => {
    setDone(false)
    setError(null)
    onClose()
  }, [onClose])

  const report = useCallback(
    async (reason: ReportReason) => {
      setBusy(true)
      setError(null)
      try {
        const result = await earth.safety.report({ targetType, targetId, reason, details: null })
        analytics.track('content_reported', { targetType, reason })
        setDone(true)
        onReported?.(result)
      } catch {
        setError(safetyCopy.couldnt)
      } finally {
        setBusy(false)
      }
    },
    [earth, analytics, targetType, targetId, onReported],
  )

  return (
    <ReportSheetView
      open={open}
      {...(title === undefined ? {} : { title })}
      busy={busy}
      done={done}
      error={error}
      onReason={(reason) => void report(reason)}
      onClose={close}
    />
  )
}
