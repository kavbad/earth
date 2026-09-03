import { copy } from '@earth/ui'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { RoomControls, type RoomControlsProps } from './RoomControls'

const noop = () => undefined
const base: RoomControlsProps = {
  mode: 'participant',
  micOn: true,
  cameraOn: true,
  canOpenUp: true,
  onMic: noop,
  onCamera: noop,
  onFlip: noop,
  onParticipants: noop,
  onOpenUp: noop,
  onMore: noop,
  onLeave: noop,
}

describe('RoomControls (SCREEN 14)', () => {
  it('names every control and offers Open up to moderators', () => {
    const html = renderToStaticMarkup(<RoomControls {...base} />)
    for (const label of Object.values(copy.roomControls)) {
      expect(html).toContain(`aria-label="${label}"`)
    }
    expect(html).toContain(`>${copy.openUp}<`)
    expect(html).toContain('aria-pressed="true"')
    // Leave is one quiet control among the others, never a red centre button.
    expect(html).not.toContain('bg-live')
    expect(html).not.toContain('bg-danger')
  })

  it('hides flip while the camera is off and Open up for non-moderators', () => {
    const html = renderToStaticMarkup(<RoomControls {...base} cameraOn={false} canOpenUp={false} />)
    expect(html).not.toContain(`aria-label="${copy.roomControls.flipCamera}"`)
    expect(html).not.toContain(`>${copy.openUp}<`)
    expect(html).toContain('aria-pressed="false"')
  })

  it('gives viewers and Guests only what they may do (SCREEN 18)', () => {
    const viewer = renderToStaticMarkup(<RoomControls {...base} mode="viewer" canOpenUp={false} />)
    expect(viewer).not.toContain(`aria-label="${copy.roomControls.microphone}"`)
    expect(viewer).toContain(`aria-label="${copy.roomControls.participants}"`)
    expect(viewer).toContain(`aria-label="${copy.roomControls.leave}"`)
    const guest = renderToStaticMarkup(<RoomControls {...base} mode="guest" canOpenUp={false} />)
    expect(guest).toContain(`aria-label="${copy.roomControls.microphone}"`)
    expect(guest).toContain(`aria-label="${copy.roomControls.camera}"`)
    expect(guest).not.toContain(`>${copy.openUp}<`)
    const visitor = renderToStaticMarkup(
      <RoomControls {...base} mode="visitor" canOpenUp={false} />,
    )
    expect((visitor.match(/<button/g) ?? []).length).toBe(1)
  })
})
