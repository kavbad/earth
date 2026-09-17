/**
 * The quiet end state: one line and a way back, never a giant error — and offline it says
 * "Connection unavailable" (spec §107) instead of a generic failure.
 */
import { copy } from '@earth/ui'
import { describe, expect, it, vi } from 'vitest'

import { roomCopy } from '@/features/rooms/copy'
import { render } from '@/test/render'

const online = { current: true }

vi.mock('@/features/rooms/shell', () => ({
  useRoomShell: () => ({ online: online.current }),
}))

const { RoomEnded } = await import('./RoomEnded')

const noop = () => undefined

describe('RoomEnded', () => {
  it('says why the room is closed and offers only the way back', () => {
    online.current = true
    let back = 0
    const screen = render(<RoomEnded kind="ended" onBack={() => (back += 1)} />)
    expect(screen.text()).toContain(roomCopy.roomEnded)
    expect(screen.byLabel(copy.tryAgain)).toHaveLength(0)
    screen.press(roomCopy.backToLive)
    expect(back).toBe(1)
  })

  it('offers "Try again" only for a read failure', () => {
    online.current = true
    const withRetry = render(<RoomEnded kind="error" onBack={noop} onRetry={noop} />)
    expect(withRetry.text()).toContain(roomCopy.couldntOpenRoom)
    expect(withRetry.byLabel(copy.tryAgain)).toHaveLength(1)
    const removed = render(<RoomEnded kind="removed" onBack={noop} onRetry={noop} />)
    expect(removed.text()).toContain(roomCopy.removedFromRoom)
    expect(removed.byLabel(copy.tryAgain)).toHaveLength(0)
  })

  it('names the network, not a generic failure, while offline (spec §107)', () => {
    online.current = false
    const screen = render(<RoomEnded kind="error" onBack={noop} onRetry={noop} />)
    expect(screen.text()).toContain(copy.connectionUnavailable)
    expect(screen.text()).not.toContain(roomCopy.couldntOpenRoom)
  })
})
