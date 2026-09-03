'use client'

/**
 * SCREEN 23 — one list, no tabs, in the server's order (priority rank, then newest; likes lower).
 * Rows are marked read as they come on screen; realtime inserts refresh the list, polling covers
 * a degraded channel. Cached rows survive a failed refresh (spec §110).
 */
import { copy } from '@earth/ui'
import { useRouter } from 'next/navigation'

import { webCopy } from '../../../lib/copy'
import { ROUTES, asRoute } from '../../../lib/routes'
import { useSession } from '../../../lib/providers/SessionProvider'
import { useClaimGate } from '../../shell/ClaimSheet'
import { PageContainer } from '../../shell/PageContainer'
import { ScreenHeader } from '../../shell/ScreenHeader'
import { Button } from '../../ui/Button'
import { EmptyState } from '../../ui/EmptyState'
import { Icon } from '../../ui/Icon'
import { Skeleton } from '../../ui/Skeleton'
import { Spinner } from '../../ui/Spinner'
import { feedCopy } from '../copy'
import { useInfiniteScroll } from '../hooks/useInfiniteScroll'
import { NotificationRow } from './NotificationRow'
import { useNotifications } from './hooks/useNotifications'

function RowsSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className="flex items-center gap-3 px-screen-margin py-3">
          <Skeleton className="size-10 rounded-avatar" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function NotificationsList() {
  const session = useSession()
  const gate = useClaimGate()
  const router = useRouter()
  const notifications = useNotifications()
  const sentinel = useInfiniteScroll(notifications.loadMore)
  const back = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) router.back()
    else router.push(asRoute(ROUTES.home))
  }

  return (
    <>
      <ScreenHeader
        title={copy.notificationsTitle}
        leading={
          <button
            type="button"
            onClick={back}
            aria-label={webCopy.back}
            className="flex size-touch-target items-center justify-center rounded-avatar text-text-primary hover:bg-subtle-fill"
          >
            <Icon name="back" />
          </button>
        }
      />
      <PageContainer>
        {session.status === 'ready' && session.roleKind !== 'human' ? (
          <EmptyState
            title={feedCopy.notificationsFor}
            action={
              <Button variant="primary" onClick={() => gate.open('public_world')}>
                {copy.claimYourPlace}
              </Button>
            }
          />
        ) : notifications.loading ? (
          <RowsSkeleton />
        ) : notifications.failed ? (
          <div className="flex flex-col items-start gap-2 px-screen-margin py-4">
            <p role="status" className="text-secondary text-text-secondary">
              {copy.couldntRefresh}
            </p>
            <Button variant="quiet" onClick={notifications.refresh}>
              {webCopy.retry}
            </Button>
          </div>
        ) : (
          <div className="fade-in flex flex-col py-2">
            {notifications.refreshFailed ? (
              <p role="status" className="px-screen-margin py-2 text-secondary text-text-secondary">
                {copy.couldntRefresh}
              </p>
            ) : null}
            {notifications.rows.length === 0 ? (
              <EmptyState title={feedCopy.nothingYet} />
            ) : (
              <ol aria-label={copy.notificationsTitle} className="flex flex-col [&>*+*]:hairline-t">
                {notifications.rows.map((row) => (
                  <li key={row.id}>
                    <NotificationRow
                      row={row}
                      onSeen={() => notifications.markRead(row.id)}
                      onAccept={notifications.acceptFriend}
                      onOpen={(opened) => notifications.markRead(opened.id)}
                    />
                  </li>
                ))}
              </ol>
            )}
            {notifications.hasMore ? (
              <div ref={sentinel} className="flex min-h-16 items-center justify-center py-4">
                {notifications.loadingMore ? <Spinner /> : null}
              </div>
            ) : null}
          </div>
        )}
      </PageContainer>
    </>
  )
}
