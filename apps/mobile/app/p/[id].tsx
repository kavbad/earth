/**
 * `/p/[id]` — SCREEN 07 and the public post link (spec §112). Keyed by id so moving between
 * posts remounts the thread; a malformed id reads as an unavailable post.
 */
import { asPostId, isUuid } from '@earth/domain'
import { colors, copy } from '@earth/ui'
import { useLocalSearchParams } from 'expo-router'
import { StyleSheet, View } from 'react-native'

import { PostDetail } from '@/components/posts/PostDetail'
import { EmptyState, IconButton, ScreenHeader } from '@/components/ui'
import { feedCopy, postCopy } from '@/features/feed/copy'
import { useBack } from '@/features/feed/hooks/useBack'
import { firstParam } from '@/features/feed/routes'

export default function PostRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>()
  const back = useBack()
  const id = firstParam(params.id)
  if (id === null || !isUuid(id)) {
    return (
      <View style={styles.screen}>
        <ScreenHeader
          title={copy.replies}
          leading={<IconButton name="back" label={feedCopy.back} onPress={back} />}
        />
        <EmptyState title={postCopy.postUnavailable} />
      </View>
    )
  }
  return <PostDetail key={id} postId={asPostId(id)} />
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
})
