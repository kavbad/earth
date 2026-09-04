/**
 * Attach a public place (SCREEN 06 "Add place"): `places_search`, pick one. A place is never a
 * device coordinate (spec §74).
 */
import type { PlaceDto } from '@earth/domain'
import { colors, copy, radius, space, touchTarget } from '@earth/ui'
import { useEffect, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'

import { feedCopy, postCopy } from '@/features/feed/copy'
import { useFeedShell } from '@/features/feed/shell'

import { EmptyState, Icon, ListRow, Sheet, Spinner, StatusLine, text } from '@/components/ui'

export const PLACE_SEARCH_DEBOUNCE_MS = 250

export interface PlaceSheetProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly onPick: (place: PlaceDto) => void
}

export function PlaceSheet({ open, onClose, onPick }: PlaceSheetProps) {
  const { earth } = useFeedShell()
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

  return (
    <Sheet open={open} onClose={onClose} title={postCopy.place} closeButton avoidKeyboard scroll>
      <View style={styles.field}>
        <Icon name="search" size="small" color={colors.textSecondary} />
        <TextInput
          value={query}
          onChangeText={onQueryChange}
          placeholder={postCopy.searchPlaces}
          placeholderTextColor={colors.textSecondary}
          autoFocus
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel={postCopy.searchPlaces}
          style={[text.body, text.primary, styles.input]}
        />
      </View>
      <View style={styles.results}>
        {searching ? (
          <Spinner label={postCopy.searchPlaces} />
        ) : failed ? (
          <StatusLine message={copy.couldntRefresh} actionLabel={feedCopy.retry} onAction={retry} />
        ) : places === null ? null : places.length === 0 ? (
          <EmptyState title={postCopy.noPlacesFound} />
        ) : (
          places.map((place, index) => (
            <ListRow
              key={place.id}
              onPress={() => {
                onPick(place)
                setQuery('')
                setPlaces(null)
                onClose()
              }}
              leading={<Icon name="location" color={colors.textSecondary} />}
              title={place.name}
              {...(place.areaName === null ? {} : { subtitle: place.areaName })}
              flush
              separator={index < places.length - 1}
            />
          ))
        )}
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  field: {
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[3],
    borderRadius: radius.medium,
    backgroundColor: colors.subtleFill,
  },
  input: { flex: 1, paddingVertical: space[2] },
  results: { marginTop: space[2], minHeight: 160 },
})
