/**
 * Attach a public place (SCREEN 10 plus sheet → Place): `places_search`, pick one, send a
 * `place` message. A place is never a device coordinate (spec §76).
 */
import type { PlaceDto } from '@earth/domain'
import { copy, space } from '@earth/ui'
import { useEffect, useState } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'

import { EmptyState, Icon, ListRow, Sheet, Spinner, StatusLine } from '@/components/ui'
import { chatCopy } from '@/features/chats/copy'
import { useChatsShell } from '@/features/chats/shell'

import { SearchField } from './SearchField'

export const PLACE_SEARCH_DEBOUNCE_MS = 250

export interface PlaceSheetProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly onPick: (place: PlaceDto) => void
}

const keyExtractor = (place: PlaceDto) => place.id

export function PlaceSheet({ open, onClose, onPick }: PlaceSheetProps) {
  const { earth } = useChatsShell()
  const [query, setQuery] = useState('')
  const [places, setPlaces] = useState<readonly PlaceDto[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  const onQueryChange = (value: string) => {
    setQuery(value)
    const empty = value.trim().length === 0
    setSearching(!empty)
    setFailed(false)
    if (empty) setPlaces(null)
  }
  const retry = () => {
    setFailed(false)
    setSearching(true)
    setAttempt((current) => current + 1)
  }

  useEffect(() => {
    const q = query.trim()
    if (!open || q.length === 0) return
    let cancelled = false
    const timer = setTimeout(() => {
      earth.places
        .search({ q })
        .then((found) => {
          if (cancelled) return
          setFailed(false)
          setPlaces(found)
        })
        .catch(() => {
          if (cancelled) return
          setFailed(true)
          setPlaces([])
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, PLACE_SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, open, earth, attempt])

  const pick = (place: PlaceDto) => {
    onPick(place)
    setQuery('')
    setPlaces(null)
    onClose()
  }

  return (
    <Sheet open={open} onClose={onClose} title={chatCopy.place} closeButton avoidKeyboard>
      <SearchField
        value={query}
        onChangeText={onQueryChange}
        placeholder={chatCopy.searchPlaces}
        label={chatCopy.searchPlaces}
        autoFocus
      />
      <View style={styles.results}>
        {searching ? (
          <Spinner label={chatCopy.searchPlaces} />
        ) : failed ? (
          <StatusLine message={copy.couldntRefresh} actionLabel={chatCopy.retry} onAction={retry} />
        ) : places === null ? null : places.length === 0 ? (
          <EmptyState title={chatCopy.noPlacesFound} />
        ) : (
          <FlatList
            data={places}
            keyExtractor={keyExtractor}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <ListRow
                flush
                leading={<Icon name="location" />}
                title={item.name}
                subtitle={item.areaName ?? undefined}
                onPress={() => pick(item)}
              />
            )}
            accessibilityRole="list"
            accessibilityLabel={chatCopy.searchPlaces}
          />
        )}
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  results: { marginTop: space[2], minHeight: 160, maxHeight: 320 },
})
