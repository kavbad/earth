'use client'

/**
 * The composer's plus sheet (SCREEN 10): Photo/video, File, Poll, Place, Here. "Here" is
 * gated by `LOCATION_SHARING_ENABLED` and hands off to the map (spec §75).
 */
import { copy } from '@earth/ui'

import { Icon } from '../ui/Icon'
import { List, ListRow } from '../ui/ListRow'
import { Sheet } from '../ui/Sheet'
import { chatCopy } from './copy'

export type PlusAction = 'photoVideo' | 'file' | 'poll' | 'place' | 'here'

export interface PlusSheetProps {
  readonly open: boolean
  readonly locationSharingEnabled: boolean
  readonly onClose: () => void
  readonly onPick: (action: PlusAction) => void
}

export function PlusSheet({ open, locationSharingEnabled, onClose, onPick }: PlusSheetProps) {
  const pick = (action: PlusAction) => () => {
    onClose()
    onPick(action)
  }
  return (
    <Sheet open={open} onClose={onClose} title={chatCopy.attach}>
      <List className="-mx-screen-margin">
        <ListRow
          as="button"
          onClick={pick('photoVideo')}
          leading={<Icon name="camera" />}
          title={copy.composerActions.photoVideo}
        />
        <ListRow
          as="button"
          onClick={pick('file')}
          leading={<Icon name="share" />}
          title={copy.composerActions.file}
        />
        <ListRow
          as="button"
          onClick={pick('poll')}
          leading={<Icon name="check" />}
          title={copy.composerActions.poll}
        />
        <ListRow
          as="button"
          onClick={pick('place')}
          leading={<Icon name="location" />}
          title={copy.composerActions.place}
        />
        {locationSharingEnabled ? (
          <ListRow
            as="button"
            onClick={pick('here')}
            leading={<Icon name="earth" />}
            title={copy.composerActions.here}
          />
        ) : null}
      </List>
    </Sheet>
  )
}
