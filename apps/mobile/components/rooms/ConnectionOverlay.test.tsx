/**
 * Spec §109 over the stage, mounted: "Reconnecting…" without actions, "Couldn't reconnect" with
 * "Try again" / "Leave", and spec §107's "Connection unavailable" while the device is offline.
 * The one shell seam (`useRoomShell`) is stubbed; everything below it is the real component.
 */
import { copy } from '@earth/ui'
import { describe, expect, it, vi } from 'vitest'

import { roomCopy } from '@/features/rooms/copy'
import { render } from '@/test/render'

const online = { current: true }

vi.mock('@/features/rooms/shell', () => ({
  useRoomShell: () => ({ online: online.current }),
}))

const { ConnectionOverlay } = await import('./ConnectionOverlay')

const noop = () => undefined

describe('ConnectionOverlay (spec §109)', () => {
  it('shows "Reconnecting…" while retrying, without actions', () => {
    online.current = true
    const screen = render(<ConnectionOverlay status="reconnecting" onRetry={noop} onLeave={noop} />)
    expect(screen.text()).toContain(copy.reconnecting)
    expect(screen.byLabel(copy.tryAgain)).toHaveLength(0)
  })

  it('offers "Try again" and "Leave" once reconnecting failed', () => {
    online.current = true
    const pressed: string[] = []
    const screen = render(
      <ConnectionOverlay
        status="failed"
        onRetry={() => pressed.push('retry')}
        onLeave={() => pressed.push('leave')}
      />,
    )
    expect(screen.text()).toContain(copy.couldntReconnect)
    screen.press(copy.tryAgain)
    screen.press(copy.leave)
    expect(pressed).toEqual(['retry', 'leave'])
  })

  it('says "Connecting…" on the first connect and nothing once connected', () => {
    online.current = true
    expect(
      render(<ConnectionOverlay status="connecting" onRetry={noop} onLeave={noop} />).text(),
    ).toContain(roomCopy.connecting)
    expect(
      render(
        <ConnectionOverlay status="connected" onRetry={noop} onLeave={noop} />,
      ).renderer.toJSON(),
    ).toBeNull()
  })

  it('says the connection is unavailable while the device is offline (spec §107)', () => {
    online.current = false
    const screen = render(<ConnectionOverlay status="reconnecting" onRetry={noop} onLeave={noop} />)
    expect(screen.text()).toContain(copy.connectionUnavailable)
    expect(screen.text()).not.toContain(copy.couldntReconnect)
  })
})
