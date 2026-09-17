'use client'

import { asPostId, isUuid } from '@earth/domain'
import { useSearchParams } from 'next/navigation'

import { Composer } from '../../../components/posts/Composer'
import { AUDIENCE_QUERY, REPLY_TO_QUERY, audienceFromQuery } from '../../../components/posts/routes'

/** Reads `?replyTo=` and `?audience=` for the composer; a malformed reply id is ignored. */
export function ComposeClient() {
  const params = useSearchParams()
  const replyTo = params.get(REPLY_TO_QUERY)
  return (
    <Composer
      replyTo={replyTo !== null && isUuid(replyTo) ? asPostId(replyTo) : null}
      presetAudience={audienceFromQuery(params.get(AUDIENCE_QUERY))}
    />
  )
}
