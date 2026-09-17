import type { Metadata } from 'next'

import { copy } from '@earth/ui'

import { NewChat } from '../../../../components/chats/NewChat'

export const metadata: Metadata = { title: copy.newChat }

/** SCREEN 09 — New chat. */
export default function NewChatPage() {
  return <NewChat />
}
