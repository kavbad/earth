/**
 * SCREEN 08 — Chats. Header "Chats" with the new-chat icon, a search field, then rows. No
 * Groups / DMs tabs. Visitors see the claim line; a failed refresh keeps the cached rows and says
 * "Couldn't refresh" inline (spec §110). "Waiting for connection" comes from the tab shell
 * (spec §107), so this screen never repeats it.
 */
import type { ConversationId, ConversationSummaryDto } from '@earth/domain'
import { colors, copy, spacing } from '@earth/ui'
import { useRouter } from 'expo-router'
import { useCallback, useMemo, useState } from 'react'
import { FlatList, RefreshControl, StyleSheet } from 'react-native'

import {
  Button,
  EmptyState,
  IconButton,
  Screen,
  ScreenHeader,
  Spinner,
  StatusLine,
} from '@/components/ui'
import { chatCopy } from '@/features/chats/copy'
import { useConversationsList } from '@/features/chats/hooks/useConversationsList'
import { NEW_CHAT_ROUTE, conversationRoute } from '@/features/chats/routes'
import { useChatsShell } from '@/features/chats/shell'
import { filterConversations } from '@/features/chats/state/list'

import { CHAT_ROW_HEIGHT, ChatRow } from './ChatRow'
import { ClaimToChat } from './ClaimToChat'
import { SearchField } from './SearchField'

const keyExtractor = (item: ConversationSummaryDto) => item.id
const getItemLayout = (
  _data: ArrayLike<ConversationSummaryDto> | null | undefined,
  index: number,
) => ({
  length: CHAT_ROW_HEIGHT,
  offset: CHAT_ROW_HEIGHT * index,
  index,
})

export function ChatsListScreen() {
  const shell = useChatsShell()
  const router = useRouter()
  const list = useConversationsList()
  const [query, setQuery] = useState('')
  const isHuman = shell.isHuman
  const filtered = useMemo(
    () => filterConversations(list.conversations, query),
    [list.conversations, query],
  )

  const open = useCallback(
    (conversationId: ConversationId) => router.push(conversationRoute(conversationId)),
    [router],
  )
  const newChat = useCallback(() => router.push(NEW_CHAT_ROUTE), [router])
  const renderItem = useCallback(
    ({ item }: { item: ConversationSummaryDto }) => (
      <ChatRow conversation={item} viewerId={shell.viewerId} onPress={open} />
    ),
    [shell.viewerId, open],
  )

  const empty = list.loading ? (
    <Spinner label={copy.chats} />
  ) : list.error && list.conversations.length === 0 ? (
    <EmptyState
      title={copy.couldntRefresh}
      action={<Button variant="secondary" label={chatCopy.retry} onPress={list.refetch} />}
    />
  ) : list.conversations.length === 0 ? (
    <EmptyState
      title={chatCopy.noChatsYet}
      body={copy.addPeopleYouKnow}
      action={<Button label={copy.newChat} onPress={newChat} />}
    />
  ) : (
    <EmptyState title={chatCopy.noMatches} />
  )

  return (
    <Screen accessibilityLabel={copy.chats}>
      <ScreenHeader
        title={copy.chats}
        large
        trailing={
          isHuman ? <IconButton name="plus" label={copy.newChat} onPress={newChat} /> : undefined
        }
      >
        {isHuman ? (
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder={copy.search}
            label={chatCopy.searchChats}
          />
        ) : undefined}
      </ScreenHeader>
      {shell.sessionStatus === 'loading' ? (
        <Spinner fill label={copy.chats} />
      ) : !isHuman ? (
        <ClaimToChat title={copy.chats} />
      ) : (
        <>
          {list.error && list.conversations.length > 0 ? (
            <StatusLine
              message={copy.couldntRefresh}
              actionLabel={chatCopy.retry}
              onAction={list.refetch}
            />
          ) : null}
          <FlatList
            data={filtered}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            getItemLayout={getItemLayout}
            onEndReached={query.length === 0 ? list.loadMore : undefined}
            onEndReachedThreshold={0.5}
            ListEmptyComponent={empty}
            ListFooterComponent={list.loadingMore ? <Spinner label={chatCopy.loadOlder} /> : null}
            refreshControl={
              <RefreshControl
                refreshing={list.refreshing && !list.loading}
                onRefresh={list.refetch}
                tintColor={colors.textSecondary}
              />
            }
            windowSize={7}
            initialNumToRender={12}
            maxToRenderPerBatch={10}
            removeClippedSubviews
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.content}
            accessibilityRole="list"
            accessibilityLabel={copy.chats}
          />
        </>
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  content: { paddingBottom: spacing.screenMargin },
})
