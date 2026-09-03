'use client'

/**
 * Attach a public place (SCREEN 10 plus sheet → Place): `places_search`, pick one, send a
 * `place` message. A place is never a device coordinate (spec §76).
 */
import type { PlaceDto } from '@earth/domain'
import { useEffect, useState } from 'react'

import { useEarth } from '../../lib/providers/RuntimeProvider'
import { EmptyState } from '../ui/EmptyState'
import { Icon } from '../ui/Icon'
import { List, ListRow } from '../ui/ListRow'
import { Sheet } from '../ui/Sheet'
import { Spinner } from '../ui/Spinner'
import { chatCopy } from './copy'

export const PLACE_SEARCH_DEBOUNCE_MS = 250

export interface PlaceSheetProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly onPick: (place: PlaceDto) => void
}

export function PlaceSheet({ open, onClose, onPick }: PlaceSheetProps) {
  const earth = useEarth()
  const [query, setQuery] = useState('')
  const [places, setPlaces] = useState<readonly PlaceDto[] | null>(null)
  const [searching, setSearching] = useState(false)

  const onQueryChange = (value: string) => {
    setQuery(value)
    const empty = value.trim().length === 0
    setSearching(!empty)
    if (empty) setPlaces(null)
  }

  useEffect(() => {
    const q = query.trim()
    if (!open || q.length === 0) return
    let cancelled = false
    const timer = setTimeout(() => {
      earth.places
        .search({ q })
        .then((found) => {
          if (!cancelled) setPlaces(found)
        })
        .catch(() => {
          if (!cancelled) setPlaces([])
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, PLACE_SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, open, earth])

  return (
    <Sheet open={open} onClose={onClose} title={chatCopy.place} closeButton>
      <label className="relative block">
        <span className="sr-only">{chatCopy.searchPlaces}</span>
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-text-secondary">
          <Icon name="search" size="small" />
        </span>
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={chatCopy.searchPlaces}
          autoComplete="off"
          autoFocus
          className="min-h-touch-target w-full rounded-medium bg-subtle-fill py-2 pr-4 pl-9 text-body text-text-primary placeholder:text-text-secondary"
        />
      </label>
      <div className="-mx-screen-margin mt-2 min-h-[160px]">
        {searching ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : places === null ? null : places.length === 0 ? (
          <EmptyState title={chatCopy.noPlacesFound} />
        ) : (
          <List>
            {places.map((place) => (
              <ListRow
                key={place.id}
                as="button"
                onClick={() => {
                  onPick(place)
                  setQuery('')
                  onClose()
                }}
                leading={<Icon name="location" />}
                title={place.name}
                subtitle={place.areaName ?? undefined}
              />
            ))}
          </List>
        )}
      </div>
    </Sheet>
  )
}
