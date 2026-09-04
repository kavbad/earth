/**
 * SCREEN 21 — one universal input; sections People, Groups, Places, Posts in the server's order.
 * People read "Xavier — 8 mutual friends · San Francisco". Visitors search people and places.
 * The results are one list with a header row per non-empty section.
 */
import type { SearchGroupDto, SearchPersonDto, SearchPlaceDto } from '@earth/domain'
import { colors, copy, formatHandle, mutualLine, space, spacing } from '@earth/ui'
import { useRouter } from 'expo-router'
import { memo, useCallback, useState } from 'react'
import { FlatList, StyleSheet, Text, View } from 'react-native'

import { PostCard } from '@/components/posts/PostCard'
import {
  Avatar,
  EmptyState,
  Icon,
  IconButton,
  ListRow,
  ScreenHeader,
  Spinner,
  StatusLine,
  text,
} from '@/components/ui'
import { feedCopy } from '@/features/feed/copy'
import { useBack } from '@/features/feed/hooks/useBack'
import { useSearch } from '@/features/feed/hooks/useSearch'
import { conversationRoute, earthPlaceHref, profileRoute } from '@/features/feed/routes'
import { useFeedShell } from '@/features/feed/shell'
import { type SearchRow, resultCount, searchRows } from '@/features/feed/state/search'

import { SearchField } from './SearchField'

export interface SearchScreenProps {
  /** `?q=` preselects a query. */
  readonly initialQuery?: string
}

function keyExtractor(row: SearchRow): string {
  return row.key
}

function SectionHeader({ title }: { readonly title: string }) {
  return (
    <Text style={[text.section, text.primary, styles.section]} accessibilityRole="header">
      {title}
    </Text>
  )
}

function PersonRowView({ person }: { readonly person: SearchPersonDto }) {
  const router = useRouter()
  const detail = mutualLine(person.mutualFriendCount, person.cityName)
  const trailing = person.isFriend
    ? feedCopy.friend
    : person.isFollowing
      ? feedCopy.following
      : null
  return (
    <ListRow
      leading={<Avatar name={person.displayName} src={person.avatarUrl} decorative />}
      title={person.displayName}
      subtitle={detail !== '' ? detail : formatHandle(person.handle)}
      accessibilityLabel={copy.searchPersonLine(person.displayName, detail)}
      trailing={
        trailing === null ? undefined : <Text style={[text.secondary, text.muted]}>{trailing}</Text>
      }
      onPress={() => router.push(profileRoute(person.handle))}
    />
  )
}
const PersonRow = memo(PersonRowView)

function GroupRowView({ group }: { readonly group: SearchGroupDto }) {
  const { earth, toast } = useFeedShell()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const name = group.name ?? feedCopy.groupFallback
  const subtitle = feedCopy.members(group.memberCount)
  const open = async () => {
    setBusy(true)
    try {
      const detail = await earth.groups.get(group.groupId)
      router.push(conversationRoute(detail.conversationId))
    } catch {
      toast(feedCopy.somethingWrong)
    } finally {
      setBusy(false)
    }
  }
  const leading = <Avatar name={name} src={group.avatarUrl} decorative />
  if (!group.isMember) return <ListRow leading={leading} title={name} subtitle={subtitle} />
  return (
    <ListRow
      leading={leading}
      title={name}
      subtitle={subtitle}
      trailing={<Text style={[text.secondary, text.muted]}>{feedCopy.member}</Text>}
      disabled={busy}
      onPress={() => void open()}
    />
  )
}
const GroupRow = memo(GroupRowView)

function PlaceRowView({ place }: { readonly place: SearchPlaceDto }) {
  const router = useRouter()
  return (
    <ListRow
      leading={<Icon name="location" color={colors.textSecondary} />}
      title={place.name}
      {...(place.areaName === null ? {} : { subtitle: place.areaName })}
      onPress={() => router.push(earthPlaceHref(place.placeId))}
    />
  )
}
const PlaceRow = memo(PlaceRowView)

function renderRow({ item }: { item: SearchRow }) {
  switch (item.kind) {
    case 'header':
      return <SectionHeader title={copy.searchSections[item.section]} />
    case 'person':
      return <PersonRow person={item.person} />
    case 'group':
      return <GroupRow group={item.group} />
    case 'place':
      return <PlaceRow place={item.place} />
    case 'post':
      return <PostCard view={item.view} context={{ source: 'search' }} />
  }
}

export function SearchScreen({ initialQuery = '' }: SearchScreenProps) {
  const shell = useFeedShell()
  const back = useBack()
  const [input, setInput] = useState(initialQuery)
  const search = useSearch(input)
  const results = search.results
  const rows = results === undefined ? [] : searchRows(results)
  const empty = results !== undefined && resultCount(results) === 0

  const body = useCallback(() => {
    if (search.query === '') {
      return <Text style={[text.secondary, text.muted, styles.hint]}>{feedCopy.searchHint}</Text>
    }
    if (search.searching) return <Spinner label={feedCopy.searchLabel} />
    if (search.failed) {
      return <StatusLine message={shell.online ? copy.couldntRefresh : copy.waitingForConnection} />
    }
    if (empty) return <EmptyState title={feedCopy.noResults(search.query)} />
    return null
  }, [empty, search.failed, search.query, search.searching, shell.online])

  return (
    <View style={styles.screen}>
      <ScreenHeader
        title={copy.search}
        leading={<IconButton name="back" label={feedCopy.back} onPress={back} />}
      >
        <SearchField
          value={input}
          onChangeText={setInput}
          placeholder={feedCopy.searchPlaceholder}
          label={feedCopy.searchLabel}
          autoFocus={initialQuery === ''}
        />
      </ScreenHeader>
      <FlatList
        data={rows}
        keyExtractor={keyExtractor}
        renderItem={renderRow}
        ListEmptyComponent={body}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        windowSize={7}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        contentContainerStyle={styles.content}
        accessibilityLabel={copy.search}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingBottom: space[6] },
  section: {
    paddingHorizontal: spacing.screenMargin,
    paddingTop: space[4],
    paddingBottom: space[1],
  },
  hint: { paddingHorizontal: spacing.screenMargin, paddingVertical: space[4] },
})
