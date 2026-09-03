/**
 * SCREEN 09 — New chat. Search Humans already on Earth, recent people, pick one for a DM or two
 * or more for a group conversation, then open the composer. No forced group name.
 */
import type { HumanId, SearchPersonDto } from '@earth/domain'
import {
  borderWidth,
  colors,
  copy,
  formatHandle,
  mutualLine,
  radius,
  space,
  spacing,
  touchTarget,
} from '@earth/ui'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import {
  Avatar,
  Button,
  EmptyState,
  Icon,
  IconButton,
  ListRow,
  Screen,
  ScreenHeader,
  Spinner,
  StatusLine,
  text,
} from '@/components/ui'
import { chatCopy } from '@/features/chats/copy'
import { useConversationsList } from '@/features/chats/hooks/useConversationsList'
import { CHATS_ROUTE, conversationRoute } from '@/features/chats/routes'
import { useChatsShell } from '@/features/chats/shell'
import {
  type Person,
  personFromSearch,
  readRecentPeople,
  recentPeople,
  rememberRecentPeople,
  toggleSelected,
} from '@/features/chats/state/recentPeople'
import { deviceStorage } from '@/lib/deviceStorage'
import { lightTap, selectionTap } from '@/lib/haptics'

import { ClaimToChat } from './ClaimToChat'
import { SearchField } from './SearchField'

export const SEARCH_DEBOUNCE_MS = 250
const PERSON_ROW_HEIGHT = 64
/** Selected-person chips draw 32pt tall; the hit area reaches the 44pt target. */
const CHIP_HEIGHT = space[8]
const CHIP_HIT_SLOP = (touchTarget - CHIP_HEIGHT) / 2

const keyExtractor = (person: Person) => person.humanId
const getItemLayout = (_data: ArrayLike<Person> | null | undefined, index: number) => ({
  length: PERSON_ROW_HEIGHT,
  offset: PERSON_ROW_HEIGHT * index,
  index,
})

export function NewChatScreen() {
  const shell = useChatsShell()
  const { earth, viewerId, track } = shell
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const list = useConversationsList()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<readonly SearchPersonDto[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchFailed, setSearchFailed] = useState(false)
  const [searchAttempt, setSearchAttempt] = useState(0)
  const [selected, setSelected] = useState<readonly Person[]>([])
  const [remembered, setRemembered] = useState<readonly Person[]>([])
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isHuman = shell.isHuman

  useEffect(() => {
    if (viewerId === null) return
    let cancelled = false
    void readRecentPeople(deviceStorage(), viewerId).then((people) => {
      if (!cancelled) setRemembered(people)
    })
    return () => {
      cancelled = true
    }
  }, [viewerId])

  const recent = useMemo(
    () => recentPeople(remembered, list.conversations, viewerId),
    [remembered, list.conversations, viewerId],
  )

  const onQueryChange = (value: string) => {
    setQuery(value)
    const empty = value.trim().length === 0
    setSearching(!empty)
    setSearchFailed(false)
    if (empty) setResults(null)
  }
  const retrySearch = () => {
    setSearchFailed(false)
    setSearching(true)
    setSearchAttempt((attempt) => attempt + 1)
  }

  useEffect(() => {
    const q = query.trim()
    if (!isHuman || q.length === 0) return
    let cancelled = false
    const timer = setTimeout(() => {
      earth.search
        .query(q)
        .then((found) => {
          if (cancelled) return
          setSearchFailed(false)
          setResults(found.people)
          track('search_performed', { queryLength: q.length, resultCount: found.people.length })
        })
        .catch(() => {
          if (cancelled) return
          setSearchFailed(true)
          setResults([])
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, isHuman, earth, track, searchAttempt])

  const isSelected = useCallback(
    (humanId: HumanId) => selected.some((person) => person.humanId === humanId),
    [selected],
  )
  const toggle = useCallback((person: Person) => {
    selectionTap()
    setError(null)
    setSelected((current) => toggleSelected(current, person))
  }, [])

  const start = async () => {
    if (selected.length === 0 || viewerId === null) return
    lightTap()
    setCreating(true)
    setError(null)
    try {
      const conversation = await earth.conversations.create({
        humanIds: selected.map((person) => person.humanId),
      })
      await rememberRecentPeople(deviceStorage(), viewerId, selected)
      router.replace(conversationRoute(conversation.id))
    } catch {
      setError(chatCopy.somethingWrong)
      setCreating(false)
    }
  }

  const shown: readonly Person[] =
    results === null
      ? recent.filter((person) => !isSelected(person.humanId))
      : results.map(personFromSearch)

  const detailFor = (person: Person): string => {
    if (results === null) return person.handle === null ? '' : formatHandle(person.handle)
    const hit = results.find((r) => r.humanId === person.humanId)
    const detail = mutualLine(hit?.mutualFriendCount ?? 0, hit?.cityName)
    return detail.length > 0 ? detail : person.handle === null ? '' : formatHandle(person.handle)
  }

  const renderItem = ({ item }: { item: Person }) => {
    const picked = isSelected(item.humanId)
    return (
      <ListRow
        leading={<Avatar name={item.displayName} src={item.avatarUrl} decorative />}
        title={item.displayName}
        subtitle={detailFor(item)}
        trailing={picked ? <Icon name="check" label={chatCopy.selected} /> : undefined}
        onPress={() => toggle(item)}
        selected={picked}
      />
    )
  }

  const back = () => {
    if (router.canGoBack()) router.back()
    else router.replace(CHATS_ROUTE)
  }

  return (
    <Screen avoidKeyboard accessibilityLabel={copy.newChat}>
      <ScreenHeader
        title={copy.newChat}
        leading={<IconButton name="back" label={chatCopy.back} onPress={back} />}
      >
        {isHuman ? (
          <SearchField
            value={query}
            onChangeText={onQueryChange}
            placeholder={chatCopy.searchPeople}
            label={chatCopy.searchPeople}
            autoFocus
          />
        ) : undefined}
      </ScreenHeader>
      {!shell.online ? <StatusLine banner message={copy.waitingForConnection} /> : null}
      {shell.sessionStatus === 'loading' ? (
        <Spinner fill label={copy.newChat} />
      ) : !isHuman ? (
        <ClaimToChat title={copy.newChat} />
      ) : (
        <View style={styles.body}>
          {selected.length > 0 ? (
            <View
              style={styles.chips}
              accessibilityLabel={chatCopy.selected}
              accessibilityRole="list"
            >
              {selected.map((person) => (
                <Pressable
                  key={person.humanId}
                  onPress={() => toggle(person)}
                  accessibilityRole="button"
                  accessibilityLabel={chatCopy.removeFromSelection(person.displayName)}
                  hitSlop={CHIP_HIT_SLOP}
                  style={styles.chip}
                >
                  <Avatar
                    name={person.displayName}
                    src={person.avatarUrl}
                    size="small"
                    decorative
                  />
                  <Text style={[text.secondary, text.primary]} numberOfLines={1}>
                    {person.displayName}
                  </Text>
                  <Icon name="close" size="small" color={colors.textSecondary} />
                </Pressable>
              ))}
            </View>
          ) : null}
          {results === null && shown.length > 0 ? (
            <Text style={[text.meta, text.muted, styles.sectionLabel]}>{chatCopy.recent}</Text>
          ) : null}
          {searching ? (
            <Spinner label={chatCopy.searchPeople} />
          ) : searchFailed ? (
            <StatusLine
              message={copy.couldntRefresh}
              actionLabel={chatCopy.retry}
              onAction={retrySearch}
            />
          ) : results !== null && shown.length === 0 ? (
            <EmptyState title={chatCopy.noPeopleFound} />
          ) : (
            <FlatList
              data={shown}
              keyExtractor={keyExtractor}
              renderItem={renderItem}
              getItemLayout={getItemLayout}
              extraData={selected}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              windowSize={5}
              initialNumToRender={12}
              style={styles.list}
              accessibilityRole="list"
            />
          )}
          <View style={[styles.footer, { paddingBottom: insets.bottom + space[3] }]}>
            {error !== null ? (
              <Text
                style={[text.secondary, text.danger, styles.error]}
                accessibilityLiveRegion="polite"
              >
                {error}
              </Text>
            ) : null}
            <Button
              label={selected.length === 1 ? copy.profileActions.message : chatCopy.startChat}
              onPress={() => void start()}
              fullWidth
              disabled={selected.length === 0}
              loading={creating}
            />
          </View>
        </View>
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  list: { flex: 1 },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space[2],
    paddingHorizontal: spacing.screenMargin,
    paddingVertical: space[3],
  },
  chip: {
    minHeight: CHIP_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingLeft: space[1],
    paddingRight: space[2],
    paddingVertical: space[1],
    borderRadius: radius.avatar,
    backgroundColor: colors.subtleFill,
  },
  sectionLabel: {
    paddingHorizontal: spacing.screenMargin,
    paddingTop: space[3],
    paddingBottom: space[1],
  },
  footer: {
    paddingHorizontal: spacing.screenMargin,
    paddingTop: space[3],
    borderTopWidth: borderWidth.hairline,
    borderTopColor: colors.separator,
    backgroundColor: colors.background,
  },
  error: { paddingBottom: space[2] },
})
