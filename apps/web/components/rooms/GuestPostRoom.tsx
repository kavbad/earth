'use client'

import { copy } from '@earth/ui'
import { useQuery } from '@tanstack/react-query'

import { useEarth, useRuntime } from '../../lib/providers/RuntimeProvider'
import { Button } from '../ui/Button'

export interface GuestPostRoomProps {
  readonly onClaim: () => void
  readonly onDone: () => void
}

/** Sessions after which the post-room screen talks about repeat rooms (SCREEN 19). */
export const REPEAT_SESSIONS_FROM = 2

/**
 * SCREEN 19 — small and optional: "Good hanging out. Claim your place if you want to stay
 * connected on Earth." — Claim my place / Done. After repeat Guest sessions: "You've joined
 * 3 Earth rooms with 11 people you know." — Claim your place.
 */
export function GuestPostRoom({ onClaim, onDone }: GuestPostRoomProps) {
  const { runtime } = useRuntime()
  const earth = useEarth()
  const sessions = useQuery({
    queryKey: ['guest', 'sessions'],
    queryFn: () => earth.guest.get(),
    enabled: runtime !== null,
    retry: 0,
  })
  const counts = sessions.data
  const repeat = counts !== undefined && counts.roomsJoined >= REPEAT_SESSIONS_FROM
  return (
    <section className="fade-in flex flex-1 flex-col justify-center gap-6 py-8">
      <p className="text-title">
        {repeat ? copy.guestRepeat(counts.roomsJoined, counts.humansMet) : copy.guestPostRoom}
      </p>
      <div className="flex flex-col gap-2">
        <Button variant="primary" fullWidth onClick={onClaim}>
          {repeat ? copy.claimYourPlace : copy.claimMyPlace}
        </Button>
        <Button variant="quiet" fullWidth onClick={onDone}>
          {copy.done}
        </Button>
      </div>
    </section>
  )
}
