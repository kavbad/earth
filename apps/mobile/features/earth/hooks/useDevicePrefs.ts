/**
 * Device preferences (SCREEN 25 Privacy and Notifications) through the query cache so every
 * screen reads one value: the default post audience, the Live defaults and the notification
 * categories. Reads are guarded (a missing store reads as the default); writes are fire-and-forget.
 */
import type { Audience } from '@earth/domain'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'

import { deviceStorage } from '../deviceStorage'
import {
  DEFAULT_AUDIENCE,
  DEFAULT_NOTIFICATION_PREFS,
  LIVE_DEFAULTS_FALLBACK,
  type LiveDefaults,
  type NotificationCategoryPrefs,
  type NotificationPrefsAction,
  notificationPrefsReducer,
  readDefaultAudience,
  readLiveDefaults,
  readNotificationPrefs,
  writeDefaultAudience,
  writeLiveDefaults,
  writeNotificationPrefs,
} from '../state/prefs'

export const PREFS_QUERY_KEY = 'prefs' as const

export interface DevicePref<T> {
  readonly value: T
  readonly loaded: boolean
  set(next: T): void
}

export function useDefaultAudience(humanId: string | null): DevicePref<Audience> {
  const queryClient = useQueryClient()
  const key = useMemo(() => [PREFS_QUERY_KEY, humanId, 'defaultAudience'] as const, [humanId])
  const query = useQuery({
    queryKey: key,
    queryFn: () => readDefaultAudience(deviceStorage(), humanId ?? ''),
    enabled: humanId !== null,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const set = useCallback(
    (next: Audience) => {
      if (humanId === null) return
      void writeDefaultAudience(deviceStorage(), humanId, next)
      queryClient.setQueryData(key, next)
    },
    [humanId, key, queryClient],
  )
  return { value: query.data ?? DEFAULT_AUDIENCE, loaded: query.data !== undefined, set }
}

export function useLiveDefaults(humanId: string | null): DevicePref<LiveDefaults> {
  const queryClient = useQueryClient()
  const key = useMemo(() => [PREFS_QUERY_KEY, humanId, 'live'] as const, [humanId])
  const query = useQuery({
    queryKey: key,
    queryFn: () => readLiveDefaults(deviceStorage(), humanId ?? ''),
    enabled: humanId !== null,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const set = useCallback(
    (next: LiveDefaults) => {
      if (humanId === null) return
      void writeLiveDefaults(deviceStorage(), humanId, next)
      queryClient.setQueryData(key, next)
    },
    [humanId, key, queryClient],
  )
  return { value: query.data ?? LIVE_DEFAULTS_FALLBACK, loaded: query.data !== undefined, set }
}

export interface NotificationPrefsController {
  readonly value: NotificationCategoryPrefs
  readonly loaded: boolean
  dispatch(action: NotificationPrefsAction): void
}

export function useNotificationPrefs(humanId: string | null): NotificationPrefsController {
  const queryClient = useQueryClient()
  const key = useMemo(() => [PREFS_QUERY_KEY, humanId, 'notifications'] as const, [humanId])
  const query = useQuery({
    queryKey: key,
    queryFn: () => readNotificationPrefs(deviceStorage(), humanId ?? ''),
    enabled: humanId !== null,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const value = query.data ?? DEFAULT_NOTIFICATION_PREFS
  const dispatch = useCallback(
    (action: NotificationPrefsAction) => {
      if (humanId === null) return
      const current = queryClient.getQueryData<NotificationCategoryPrefs>(key) ?? value
      const next = notificationPrefsReducer(current, action)
      void writeNotificationPrefs(deviceStorage(), humanId, next)
      queryClient.setQueryData(key, next)
    },
    [humanId, key, queryClient, value],
  )
  return { value, loaded: query.data !== undefined, dispatch }
}
