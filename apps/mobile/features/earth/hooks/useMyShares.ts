/**
 * The Human's own location shares (spec §75): remembered on this device with their audience
 * names, reconciled with `location_shares_mine()` (the server decides which still exist), read
 * through the query cache so the map, the list and the updater see one value. Never a position.
 */
import type { LocationShareDto } from '@earth/domain'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { earthCopy, locationCopy } from '../copy'
import { deviceStorage } from '../deviceStorage'
import { lightTap } from '../haptics'
import { useEarthShell } from '../shell'
import {
  type MyShare,
  addMyShare,
  readMyShares,
  removeMyShare,
  writeMyShares,
} from '../state/myShares'
import { type AudienceNameSource, mergeWithServer, myShareFromDto } from '../state/shareSync'

export const MY_SHARES_QUERY_KEY = 'my-shares' as const
const EMPTY: readonly MyShare[] = []

export interface MySharesController {
  readonly shares: readonly MyShare[]
  readonly loading: boolean
  /** The share being revoked right now, if any. */
  readonly revoking: string | null
  /** Remembers a share this device just created. */
  add(share: LocationShareDto, audienceName: string): void
  /** `location_share_revoke`; `true` when the server accepted it. */
  revoke(share: MyShare): Promise<boolean>
}

export interface UseMySharesOptions {
  readonly enabled: boolean
  /** Audiences this device knows names for (a share started elsewhere borrows one). */
  readonly known: readonly AudienceNameSource[]
}

export function useMyShares({ enabled, known }: UseMySharesOptions): MySharesController {
  const shell = useEarthShell()
  const { earth, toast } = shell
  const queryClient = useQueryClient()
  const humanId = shell.viewerId
  const key = useMemo(() => [MY_SHARES_QUERY_KEY, humanId] as const, [humanId])
  const knownRef = useRef(known)
  useEffect(() => {
    knownRef.current = known
  }, [known])
  const [revoking, setRevoking] = useState<string | null>(null)

  const query = useQuery({
    queryKey: key,
    queryFn: async (): Promise<MyShare[]> => {
      if (humanId === null) return []
      const now = Date.now()
      const device = await readMyShares(deviceStorage(), humanId, now)
      let server: readonly LocationShareDto[] | null = null
      try {
        server = await earth.location.myShares()
      } catch {
        // Offline or an older server: the device's memory stands until the next read.
        server = null
      }
      if (server === null) return device
      const merged = mergeWithServer(device, server, knownRef.current, now)
      await writeMyShares(deviceStorage(), humanId, merged)
      return merged
    },
    enabled: enabled && shell.ready && shell.isHuman && humanId !== null,
    staleTime: 60_000,
  })

  const persist = useCallback(
    (next: readonly MyShare[]) => {
      if (humanId !== null) void writeMyShares(deviceStorage(), humanId, next)
      queryClient.setQueryData(key, next)
    },
    [humanId, key, queryClient],
  )

  const shares = query.data ?? EMPTY

  const add = useCallback(
    (share: LocationShareDto, audienceName: string) => {
      persist(addMyShare(shares, myShareFromDto(share, audienceName)))
    },
    [persist, shares],
  )

  const revoke = useCallback(
    async (share: MyShare): Promise<boolean> => {
      lightTap()
      setRevoking(share.id)
      try {
        await earth.location.revokeShare(share.id)
        persist(removeMyShare(shares, share.id))
        toast(locationCopy.stopped)
        return true
      } catch {
        toast(earthCopy.somethingWrong)
        return false
      } finally {
        setRevoking(null)
      }
    },
    [earth, persist, shares, toast],
  )

  return {
    shares,
    loading: query.isPending && query.fetchStatus !== 'idle',
    revoking,
    add,
    revoke,
  }
}
