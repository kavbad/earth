/**
 * `/compose` — SCREEN 06, presented as a modal over the tabs. `?replyTo=<postId>` opens a reply
 * capped by the root audience; `?audience=<audience>` presets the Home radius the person came
 * from. A malformed reply id is ignored.
 */
import { asPostId, isUuid } from '@earth/domain'
import { useLocalSearchParams } from 'expo-router'

import { Composer } from '@/components/posts/Composer'
import {
  AUDIENCE_QUERY,
  REPLY_TO_QUERY,
  audienceFromQuery,
  firstParam,
} from '@/features/feed/routes'

export default function ComposeRoute() {
  const params = useLocalSearchParams<{
    [REPLY_TO_QUERY]?: string | string[]
    [AUDIENCE_QUERY]?: string | string[]
  }>()
  const replyTo = firstParam(params[REPLY_TO_QUERY])
  const audience = firstParam(params[AUDIENCE_QUERY])
  return (
    <Composer
      replyTo={replyTo !== null && isUuid(replyTo) ? asPostId(replyTo) : null}
      presetAudience={audienceFromQuery(audience)}
    />
  )
}
