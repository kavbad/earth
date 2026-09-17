/**
 * Settings → Safety (spec §81): who is blocked (`blocks_list()` with identities) and the report
 * history (`reports_mine()`), through react-query; Unblock folds back into the cached list.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'

import { earthCopy, safetyCopy } from '../copy'
import { lightTap } from '../haptics'
import { useEarthShell } from '../shell'
import {
  type BlockedHuman,
  type ReportHistoryItem,
  blockedName,
  listBlockedHumans,
  listMyReports,
  withoutBlocked,
} from '../state/safety'

export const BLOCKS_QUERY_KEY = 'blocks' as const
export const REPORTS_QUERY_KEY = 'reports' as const

export interface BlockedHumansController {
  readonly blocks: readonly BlockedHuman[] | undefined
  readonly loading: boolean
  readonly failed: boolean
  readonly unblocking: string | null
  refetch(): void
  unblock(block: BlockedHuman): Promise<boolean>
}

export function useBlockedHumans(): BlockedHumansController {
  const shell = useEarthShell()
  const { earth, toast } = shell
  const queryClient = useQueryClient()
  const key = useMemo(() => [BLOCKS_QUERY_KEY, shell.viewerId] as const, [shell.viewerId])
  const enabled = shell.ready && shell.isHuman
  const query = useQuery({
    queryKey: key,
    queryFn: () => listBlockedHumans(earth),
    enabled,
  })
  const [unblocking, setUnblocking] = useState<string | null>(null)
  const { refetch } = query

  const unblock = useCallback(
    async (block: BlockedHuman): Promise<boolean> => {
      lightTap()
      setUnblocking(block.blockedHumanId)
      try {
        await earth.social.unblock(block.blockedHumanId)
        queryClient.setQueryData<BlockedHuman[]>(key, (current) =>
          current === undefined ? current : withoutBlocked(current, block.blockedHumanId),
        )
        toast(safetyCopy.unblocked(blockedName(block)))
        return true
      } catch {
        toast(earthCopy.somethingWrong)
        return false
      } finally {
        setUnblocking(null)
      }
    },
    [earth, key, queryClient, toast],
  )

  return {
    blocks: query.data,
    loading: enabled && query.isPending,
    failed: query.isError && query.data === undefined,
    unblocking,
    refetch: () => {
      void refetch()
    },
    unblock,
  }
}

export interface ReportHistoryController {
  readonly reports: readonly ReportHistoryItem[] | undefined
  readonly loading: boolean
  readonly failed: boolean
  refetch(): void
}

export function useReportHistory(): ReportHistoryController {
  const shell = useEarthShell()
  const { earth } = shell
  const enabled = shell.ready && shell.isHuman
  const query = useQuery({
    queryKey: [REPORTS_QUERY_KEY, shell.viewerId],
    queryFn: () => listMyReports(earth),
    enabled,
  })
  const { refetch } = query
  return {
    reports: query.data,
    loading: enabled && query.isPending,
    failed: query.isError && query.data === undefined,
    refetch: () => {
      void refetch()
    },
  }
}
