/**
 * `/rooms/[id]` — SCREEN 14, the Active Room. Lives outside the member shell so the stage owns
 * the whole viewport; everything in it renders on the client (LiveKit is browser-only).
 */
import { RoomIdSchema } from '@earth/domain'
import { copy } from '@earth/ui'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'

import { RoomPageClient } from '../../../components/rooms/RoomPageClient'

export const metadata: Metadata = { title: copy.tabs.live }

type Params = Promise<{ readonly id: string }>

export default async function RoomPage({ params }: { params: Params }) {
  const { id } = await params
  const parsed = RoomIdSchema.safeParse(id)
  if (!parsed.success) notFound()
  return <RoomPageClient roomId={parsed.data} />
}
