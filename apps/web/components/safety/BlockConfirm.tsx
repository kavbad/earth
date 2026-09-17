'use client'

/**
 * Block (spec §21, §56, §81): a plain confirmation that says what changes — and that a shared
 * group keeps working for both. Calls `block_set`, tracks `human_blocked` (spec §97).
 */
import type { SourceSurface } from '@earth/analytics'
import type { BlockChangeDto } from '@earth/api'
import type { HumanId } from '@earth/domain'
import { copy } from '@earth/ui'
import { useCallback, useState } from 'react'

import { useAnalytics } from '../../lib/providers/AnalyticsProvider'
import { useEarth } from '../../lib/providers/RuntimeProvider'
import { useToast } from '../ui/Toast'
import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { safetyCopy } from './copy'

export interface BlockConfirmViewProps {
  readonly open: boolean
  readonly displayName: string
  readonly busy?: boolean
  readonly error?: string | null
  readonly onConfirm: () => void
  readonly onClose: () => void
}

/** Presentational confirmation (no providers), exported for tests and reuse. */
export function BlockConfirmView({
  open,
  displayName,
  busy = false,
  error = null,
  onConfirm,
  onClose,
}: BlockConfirmViewProps) {
  return (
    <Sheet open={open} onClose={onClose} title={safetyCopy.blockTitle(displayName)}>
      <div className="flex flex-col gap-4">
        <p className="text-body">{safetyCopy.blockBody(displayName)}</p>
        <p className="text-secondary text-text-secondary">{safetyCopy.blockGroups}</p>
        {error !== null ? (
          <p role="alert" className="text-secondary text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          <Button variant="primary" fullWidth loading={busy} onClick={onConfirm}>
            {copy.safety.block}
          </Button>
          <Button variant="quiet" fullWidth onClick={onClose}>
            {copy.notNow}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}

export interface BlockConfirmProps {
  readonly open: boolean
  readonly humanId: HumanId
  readonly displayName: string
  /** Where the block was asked for (`profile`, `post`, `room`, …) for `human_blocked`. */
  readonly source: SourceSurface
  readonly onClose: () => void
  readonly onBlocked?: ((change: BlockChangeDto) => void) | undefined
}

export function BlockConfirm({
  open,
  humanId,
  displayName,
  source,
  onClose,
  onBlocked,
}: BlockConfirmProps) {
  const earth = useEarth()
  const analytics = useAnalytics()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const change = await earth.social.block(humanId)
      analytics.track('human_blocked', { targetHumanId: humanId, source })
      toast.show(safetyCopy.blocked(displayName))
      onBlocked?.(change)
      onClose()
    } catch {
      setError(safetyCopy.couldnt)
    } finally {
      setBusy(false)
    }
  }, [earth, analytics, toast, humanId, displayName, source, onBlocked, onClose])

  return (
    <BlockConfirmView
      open={open}
      displayName={displayName}
      busy={busy}
      error={error}
      onConfirm={() => void confirm()}
      onClose={onClose}
    />
  )
}
