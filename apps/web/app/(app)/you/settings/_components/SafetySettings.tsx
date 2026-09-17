'use client'

/**
 * SCREEN 25 → Safety: Blocked Humans (with Unblock) and the report history (spec §81–§82).
 */
import { copy, formatHandle, relativeTime } from '@earth/ui'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { safetyCopy } from '../../../../../components/safety/copy'
import { Avatar } from '../../../../../components/ui/Avatar'
import { Button } from '../../../../../components/ui/Button'
import { List, ListRow } from '../../../../../components/ui/ListRow'
import { Skeleton } from '../../../../../components/ui/Skeleton'
import { useToast } from '../../../../../components/ui/Toast'
import { webCopy } from '../../../../../lib/copy'
import { useEarth, useRuntime } from '../../../../../lib/providers/RuntimeProvider'
import { useSession } from '../../../../../lib/providers/SessionProvider'
import { youCopy } from '../../_lib/copy'
import { type BlockedHuman, listBlockedHumans, listMyReports } from '../_lib/safetyLists'
import { SettingsSection } from './SettingsFrame'

const items = copy.settings.sections.safety.items

export const BLOCKS_QUERY_KEY = 'blocks' as const
export const REPORTS_QUERY_KEY = 'reports' as const

function blockedName(block: BlockedHuman): string {
  return block.identity?.displayName ?? copy.human
}

function Loading() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3 px-screen-margin">
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="h-4 w-1/3" />
    </div>
  )
}

function Failed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center gap-3 px-screen-margin">
      <p role="status" className="text-secondary text-text-secondary">
        {copy.couldntRefresh}
      </p>
      <Button variant="quiet" onClick={onRetry}>
        {webCopy.retry}
      </Button>
    </div>
  )
}

export function SafetySettings() {
  const { runtime } = useRuntime()
  const earth = useEarth()
  const session = useSession()
  const toast = useToast()
  const enabled = runtime !== null && session.roleKind === 'human'
  const [unblocking, setUnblocking] = useState<string | null>(null)

  const blocks = useQuery({
    queryKey: [BLOCKS_QUERY_KEY, session.humanId],
    queryFn: () => listBlockedHumans(earth),
    enabled,
  })
  const reports = useQuery({
    queryKey: [REPORTS_QUERY_KEY, session.humanId],
    queryFn: () => listMyReports(earth),
    enabled,
  })

  const unblock = async (block: BlockedHuman) => {
    setUnblocking(block.blockedHumanId)
    try {
      await earth.social.unblock(block.blockedHumanId)
      toast.show(safetyCopy.unblocked(blockedName(block)))
      await blocks.refetch()
    } catch {
      toast.show(webCopy.somethingWrong)
    } finally {
      setUnblocking(null)
    }
  }

  return (
    <>
      <SettingsSection title={items.blockedHumans} hint={safetyCopy.blockGroups}>
        {blocks.data === undefined ? (
          blocks.isError ? (
            <Failed onRetry={() => void blocks.refetch()} />
          ) : (
            <Loading />
          )
        ) : blocks.data.length === 0 ? (
          <p className="px-screen-margin text-secondary text-text-secondary">
            {youCopy.nobodyBlocked}
          </p>
        ) : (
          <List>
            {blocks.data.map((block) => (
              <ListRow
                key={block.blockedHumanId}
                leading={
                  <Avatar
                    name={blockedName(block)}
                    src={block.identity?.avatarUrl ?? null}
                    size="small"
                    decorative
                  />
                }
                title={blockedName(block)}
                subtitle={
                  block.identity?.handle !== null && block.identity?.handle !== undefined
                    ? formatHandle(block.identity.handle)
                    : relativeTime(block.createdAt)
                }
                trailing={
                  <Button
                    variant="quiet"
                    loading={unblocking === block.blockedHumanId}
                    onClick={() => void unblock(block)}
                  >
                    {copy.safety.unblock}
                  </Button>
                }
              />
            ))}
          </List>
        )}
      </SettingsSection>
      <SettingsSection title={items.reportHistory}>
        {reports.data === undefined ? (
          reports.isError ? (
            <Failed onRetry={() => void reports.refetch()} />
          ) : (
            <Loading />
          )
        ) : reports.data.length === 0 ? (
          <p className="px-screen-margin text-secondary text-text-secondary">{youCopy.noReports}</p>
        ) : (
          <List>
            {reports.data.map((report) => (
              <ListRow
                key={report.id}
                title={
                  report.reason !== null && report.reason !== undefined
                    ? copy.reportReasons[report.reason]
                    : copy.safety.report
                }
                subtitle={[
                  report.targetType !== null && report.targetType !== undefined
                    ? youCopy.reportTargets[report.targetType]
                    : null,
                  youCopy.reportStatus[report.status],
                  relativeTime(report.createdAt),
                ]
                  .filter((part): part is string => part !== null)
                  .join(' · ')}
              />
            ))}
          </List>
        )}
      </SettingsSection>
    </>
  )
}
