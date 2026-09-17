'use client'

/**
 * Who is sharing (SCREEN 20 list / Settings → Privacy → Location): the Human's own active
 * shares with "Stop sharing", and the friends whose shares reach them.
 */
import { copy } from '@earth/ui'

import { Avatar } from '../ui/Avatar'
import { Button } from '../ui/Button'
import { List, ListRow } from '../ui/ListRow'
import type { FriendMarker } from '../map/state/markers'
import { locationCopy } from './copy'
import { formatClock } from './state/duration'
import type { MyShare } from './state/myShares'

export interface VisibleSharesListProps {
  readonly mine: readonly MyShare[]
  readonly friends: readonly FriendMarker[]
  readonly busyShareId?: string | null
  readonly onRevoke: (share: MyShare) => void
  readonly onFocusFriend?: ((friend: FriendMarker) => void) | undefined
}

export function VisibleSharesList({
  mine,
  friends,
  busyShareId = null,
  onRevoke,
  onFocusFriend,
}: VisibleSharesListProps) {
  return (
    <div className="flex flex-col gap-4">
      <section aria-label={locationCopy.yourShares} className="flex flex-col gap-1">
        <h3 className="px-screen-margin text-meta text-text-secondary">
          {locationCopy.yourShares}
        </h3>
        {mine.length === 0 ? (
          <p className="px-screen-margin text-secondary text-text-secondary">
            {locationCopy.nothingShared}
          </p>
        ) : (
          <List>
            {mine.map((share) => (
              <ListRow
                key={share.id}
                title={copy.shareWith(share.audienceName)}
                subtitle={`${locationCopy.precision[share.precision]} · ${locationCopy.until(formatClock(new Date(share.expiresAt)))}`}
                trailing={
                  <Button
                    variant="quiet"
                    loading={busyShareId === share.id}
                    onClick={() => onRevoke(share)}
                  >
                    {locationCopy.stopSharing}
                  </Button>
                }
              />
            ))}
          </List>
        )}
      </section>
      <section aria-label={locationCopy.friendsSharing} className="flex flex-col gap-1">
        <h3 className="px-screen-margin text-meta text-text-secondary">
          {locationCopy.friendsSharing}
        </h3>
        {friends.length === 0 ? (
          <p className="px-screen-margin text-secondary text-text-secondary">
            {locationCopy.noFriendsSharing}
          </p>
        ) : (
          <List>
            {friends.map((friend) =>
              onFocusFriend === undefined ? (
                <ListRow
                  key={friend.id}
                  leading={
                    <Avatar
                      name={friend.displayName}
                      src={friend.avatarUrl}
                      size="small"
                      decorative
                    />
                  }
                  title={friend.displayName}
                  subtitle={`${locationCopy.precision[friend.precision]} · ${locationCopy.until(formatClock(new Date(friend.expiresAt)))}`}
                />
              ) : (
                <ListRow
                  key={friend.id}
                  as="button"
                  aria-label={locationCopy.showOnMap(friend.displayName)}
                  onClick={() => onFocusFriend(friend)}
                  leading={
                    <Avatar
                      name={friend.displayName}
                      src={friend.avatarUrl}
                      size="small"
                      decorative
                    />
                  }
                  title={friend.displayName}
                  subtitle={`${locationCopy.precision[friend.precision]} · ${locationCopy.until(formatClock(new Date(friend.expiresAt)))}`}
                />
              ),
            )}
          </List>
        )}
      </section>
    </div>
  )
}
