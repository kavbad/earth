import type { Metadata } from 'next'
import { Suspense } from 'react'

import { postCopy } from '../../../components/posts/copy'
import { ComposeClient } from './ComposeClient'

export const metadata: Metadata = { title: postCopy.compose }

/** SCREEN 06 — the post composer (`?replyTo=` for a reply, `?audience=` for the Home radius). */
export default function ComposePage() {
  return (
    <Suspense fallback={null}>
      <ComposeClient />
    </Suspense>
  )
}
