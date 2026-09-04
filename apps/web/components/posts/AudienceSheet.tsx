'use client'

/**
 * SCREEN 06 audience picker: Friends · Neighborhood · City · World as plain rows, the current one
 * checked. A reply only offers what stays within the root's audience (spec §72).
 */
import type { Audience } from '@earth/domain'
import { copy } from '@earth/ui'

import { Icon } from '../ui/Icon'
import { List, ListRow } from '../ui/ListRow'
import { Sheet } from '../ui/Sheet'
import { postCopy } from './copy'

export interface AudienceSheetProps {
  readonly open: boolean
  readonly value: Audience
  readonly options: readonly Audience[]
  readonly cap: Audience | null
  readonly onSelect: (audience: Audience) => void
  readonly onClose: () => void
}

export function AudienceSheet({
  open,
  value,
  options,
  cap,
  onSelect,
  onClose,
}: AudienceSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title={postCopy.audienceTitle} closeButton>
      <List>
        {options.map((audience) => (
          <ListRow
            key={audience}
            as="button"
            title={copy.audiences[audience]}
            aria-pressed={audience === value}
            trailing={
              audience === value ? <Icon name="check" size="small" title={copy.done} /> : undefined
            }
            onClick={() => {
              onSelect(audience)
              onClose()
            }}
            className="px-0"
          />
        ))}
      </List>
      {cap !== null ? (
        <p className="mt-3 text-secondary text-text-secondary">
          {postCopy.audienceCapped(copy.audiences[cap])}
        </p>
      ) : null}
    </Sheet>
  )
}
