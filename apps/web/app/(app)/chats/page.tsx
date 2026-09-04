import type { Metadata } from 'next'

import { copy } from '@earth/ui'

import { ChatsList } from '../../../components/chats/ChatsList'

export const metadata: Metadata = { title: copy.chats }

/** SCREEN 08 — Chats. */
export default function ChatsPage() {
  return <ChatsList />
}
