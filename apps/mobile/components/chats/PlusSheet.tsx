/**
 * The composer's plus sheet (SCREEN 10): Photo/video, File, Poll, Place, Here. "File" shows only
 * when a document picker is installed; "Here" is gated by `LOCATION_SHARING_ENABLED` and hands
 * off to the map (spec §75). Twelve icons never show permanently — five rows, on demand.
 */
import { copy } from '@earth/ui'
import { View } from 'react-native'

import { Icon, ListRow, Sheet } from '@/components/ui'
import { chatCopy } from '@/features/chats/copy'
import { FILE_PICKER_AVAILABLE } from '@/features/chats/media'

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
  const last: PlusAction = locationSharingEnabled ? 'here' : 'place'
  return (
    <Sheet open={open} onClose={onClose} title={chatCopy.attach}>
      <View accessibilityRole="menu" accessibilityLabel={chatCopy.attach}>
        <ListRow
          flush
          leading={<Icon name="camera" />}
          title={copy.composerActions.photoVideo}
          onPress={pick('photoVideo')}
        />
        {FILE_PICKER_AVAILABLE ? (
          <ListRow
            flush
            leading={<Icon name="share" />}
            title={copy.composerActions.file}
            onPress={pick('file')}
          />
        ) : null}
        <ListRow
          flush
          leading={<Icon name="check" />}
          title={copy.composerActions.poll}
          onPress={pick('poll')}
        />
        <ListRow
          flush
          leading={<Icon name="location" />}
          title={copy.composerActions.place}
          onPress={pick('place')}
          separator={last !== 'place'}
        />
        {locationSharingEnabled ? (
          <ListRow
            flush
            leading={<Icon name="earth" />}
            title={copy.composerActions.here}
            onPress={pick('here')}
            separator={false}
          />
        ) : null}
      </View>
    </Sheet>
  )
}
