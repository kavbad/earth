'use client'

import type { RoomId } from '@earth/domain'
import dynamic from 'next/dynamic'

import { Spinner } from '../ui/Spinner'

function RoomLoading() {
  return (
    <div className="flex h-dvh items-center justify-center bg-background">
      <Spinner />
    </div>
  )
}

/** The LiveKit SDK is browser-only: the room screen is loaded on the client, never prerendered. */
const RoomScreen = dynamic(() => import('./RoomScreen').then((m) => m.RoomScreen), {
  ssr: false,
  loading: RoomLoading,
})

export function RoomPageClient({ roomId }: { readonly roomId: RoomId }) {
  return <RoomScreen roomId={roomId} />
}
