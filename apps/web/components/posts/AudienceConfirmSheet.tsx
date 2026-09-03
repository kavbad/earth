'use client'

/**
 * SCREEN 06: the stronger — not scary — confirmation when a post moves materially outward from
 * what the person usually posts to. Shown once per composer per audience.
 */
import type { Audience } from '@earth/domain'
import { copy } from '@earth/ui'

import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { postCopy } from './copy'

export interface AudienceConfirmSheetProps {
  /** The audience waiting for confirmation; the sheet is closed when `null`. */
  readonly pending: Audience | null
  /** What the person usually posts to (the member default when unknown). */
  readonly usual: Audience
  /** The audience the composer keeps if they decline. */
  readonly current: Audience
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

export function AudienceConfirmSheet({
  pending,
  usual,
  current,
  onConfirm,
  onCancel,
}: AudienceConfirmSheetProps) {
  const label = pending === null ? '' : copy.audiences[pending]
  const usualLabel = copy.audiences[usual]
  return (
    <Sheet open={pending !== null} onClose={onCancel} title={postCopy.confirmTitle(label)}>
      <p className="mb-4 text-body text-text-secondary">
        {pending === 'world'
          ? postCopy.confirmWorldBody(usualLabel)
          : postCopy.confirmBody(label, usualLabel)}
      </p>
      <div className="flex flex-col gap-2">
        <Button variant="primary" fullWidth onClick={onConfirm}>
          {postCopy.postTo(label)}
        </Button>
        <Button variant="quiet" fullWidth onClick={onCancel}>
          {postCopy.keepUsual(copy.audiences[current])}
        </Button>
      </div>
    </Sheet>
  )
}
