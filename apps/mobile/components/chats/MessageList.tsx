/**
 * The thread (SCREEN 10/11): an inverted `FlatList`, newest at the bottom, memoized rows, a
 * tuned window, older pages requested as the reader nears the top (the list's end), and
 * `maintainVisibleContentPosition` so arrivals never yank the reader while they scroll back.
 */
import { colors, space, spacing, touchTarget } from '@earth/ui'
import { type ReactElement, useCallback, useMemo } from 'react'
import { FlatList, Platform, Pressable, StyleSheet, Text, View } from 'react-native'

import { chatCopy } from '@/features/chats/copy'
import { type MessageRow, invertRows } from '@/features/chats/state/messages'

import { Spinner, text } from '@/components/ui'

export interface MessageListProps {
  /** Ascending rows (oldest first); the list inverts them. */
  readonly rows: readonly MessageRow[]
  readonly renderRow: (row: MessageRow) => ReactElement
  readonly hasOlder: boolean
  readonly loadingOlder: boolean
  readonly onLoadOlder: () => void
  readonly label: string
  /** Shown when the thread is empty ("Say hello."). */
  readonly emptyLine: string
}

const keyExtractor = (row: MessageRow) => row.message.id

export function MessageList({
  rows,
  renderRow,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  label,
  emptyLine,
}: MessageListProps) {
  const inverted = useMemo(() => invertRows(rows), [rows])
  const renderItem = useCallback(({ item }: { item: MessageRow }) => renderRow(item), [renderRow])

  if (rows.length === 0) {
    return (
      <View style={styles.empty}>
        {loadingOlder ? (
          <Spinner label={chatCopy.loadOlder} />
        ) : (
          <Text style={[text.secondary, text.muted]}>{emptyLine}</Text>
        )}
      </View>
    )
  }

  // The footer of an inverted list is its visual top: where older messages are asked for.
  const footer = (
    <View style={styles.footer}>
      {loadingOlder ? (
        <Spinner label={chatCopy.loadOlder} />
      ) : hasOlder ? (
        <Pressable
          onPress={onLoadOlder}
          accessibilityRole="button"
          accessibilityLabel={chatCopy.loadOlder}
          style={styles.older}
        >
          <Text style={[text.secondary, text.muted]}>{chatCopy.loadOlder}</Text>
        </Pressable>
      ) : null}
    </View>
  )

  return (
    <FlatList
      inverted
      data={inverted}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      onEndReached={hasOlder && !loadingOlder ? onLoadOlder : undefined}
      onEndReachedThreshold={0.6}
      ListFooterComponent={footer}
      maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 80 }}
      windowSize={7}
      initialNumToRender={20}
      maxToRenderPerBatch={12}
      updateCellsBatchingPeriod={40}
      removeClippedSubviews={Platform.OS === 'android'}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.content}
      style={styles.list}
      accessibilityRole="list"
      accessibilityLabel={label}
    />
  )
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: colors.background },
  content: { paddingVertical: space[2] },
  footer: { minHeight: touchTarget, alignItems: 'center', justifyContent: 'center' },
  older: { minHeight: touchTarget, paddingHorizontal: space[4], justifyContent: 'center' },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.screenMargin,
  },
})
