import { asConversationId, isUuid } from '@earth/domain'
import { colors, copy } from '@earth/ui'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { StyleSheet, View } from 'react-native'

import { ConversationScreen } from '@/components/chats/ConversationScreen'
import { EmptyState, IconButton, ScreenHeader } from '@/components/ui'
import { chatCopy } from '@/features/chats/copy'
import { CHATS_ROUTE } from '@/features/chats/routes'

/** SCREEN 10 / 11 — a conversation. Keyed by id so moving between chats remounts the thread. */
export default function ConversationRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>()
  const router = useRouter()
  const id = Array.isArray(params.id) ? params.id[0] : params.id
  if (id === undefined || !isUuid(id)) {
    const back = () => {
      if (router.canGoBack()) router.back()
      else router.replace(CHATS_ROUTE)
    }
    return (
      <View style={styles.screen}>
        <ScreenHeader
          title={copy.chats}
          leading={<IconButton name="back" label={chatCopy.back} onPress={back} />}
        />
        <EmptyState title={chatCopy.conversationUnavailable} />
      </View>
    )
  }
  return <ConversationScreen key={id} conversationId={asConversationId(id)} />
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
})
