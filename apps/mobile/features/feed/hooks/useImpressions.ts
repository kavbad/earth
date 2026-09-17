/**
 * Impressions for a FlatList (spec §97 `post_impression` / `live_card_impression`): a row counts
 * as seen once at least half of it is on screen, reported once per key for the life of the list.
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ViewToken, ViewabilityConfig } from 'react-native'

import { newlySeenKeys } from '../state/feed'

/** Half the card visible counts as seen. */
export const IMPRESSION_THRESHOLD_PERCENT = 50
/** A card must stay on screen this long before it counts (a fast scroll past is not a view). */
export const IMPRESSION_MIN_VIEW_TIME_MS = 250

export interface Impressions<T> {
  readonly viewabilityConfig: ViewabilityConfig
  readonly onViewableItemsChanged: (info: { viewableItems: ReadonlyArray<ViewToken<T>> }) => void
}

export function useImpressions<T>(
  keyOf: (item: T) => string,
  onSeen: (item: T) => void,
): Impressions<T> {
  const seen = useRef<Set<string>>(new Set())
  const latest = useRef({ keyOf, onSeen })
  useEffect(() => {
    latest.current = { keyOf, onSeen }
  })

  const viewabilityConfig = useMemo<ViewabilityConfig>(
    () => ({
      itemVisiblePercentThreshold: IMPRESSION_THRESHOLD_PERCENT,
      minimumViewTime: IMPRESSION_MIN_VIEW_TIME_MS,
    }),
    [],
  )

  const onViewableItemsChanged = useCallback(
    (info: { viewableItems: ReadonlyArray<ViewToken<T>> }) => {
      const visible = info.viewableItems.filter((token) => token.isViewable)
      const keys = visible.map((token) => latest.current.keyOf(token.item))
      const fresh = newlySeenKeys(seen.current, keys)
      if (fresh.length === 0) return
      for (const token of visible) {
        const key = latest.current.keyOf(token.item)
        if (!fresh.includes(key) || seen.current.has(key)) continue
        seen.current.add(key)
        latest.current.onSeen(token.item)
      }
    },
    [],
  )

  return { viewabilityConfig, onViewableItemsChanged }
}
