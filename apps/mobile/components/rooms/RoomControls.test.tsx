/**
 * SCREEN 14: microphone, camera, flip, participants, Open up, more, leave — every one named for
 * assistive tech, Leave one quiet control among the others. Mirrors apps/web's RoomControls test.
 */
import { copy } from '@earth/ui'
import { describe, expect, it } from 'vitest'

import { render } from '@/test/render'

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
    const screen = render(<RoomControls {...base} />)
    for (const label of Object.values(copy.roomControls)) {
      expect(screen.byLabel(label)).toHaveLength(1)
    }
    expect(screen.text()).toContain(copy.openUp)
    expect(screen.byLabel(copy.roomControls.microphone)[0]?.props['accessibilityState']).toEqual({
      disabled: false,
      selected: true,
    })
  })

  it('hides flip while the camera is off and Open up for non-moderators', () => {
    const screen = render(<RoomControls {...base} cameraOn={false} canOpenUp={false} />)
    expect(screen.byLabel(copy.roomControls.flipCamera)).toHaveLength(0)
    expect(screen.text()).not.toContain(copy.openUp)
    expect(screen.byLabel(copy.roomControls.camera)[0]?.props['accessibilityState']).toEqual({
      disabled: false,
      selected: false,
    })
  })

  it('gives viewers and Visitors only what they may do', () => {
    const viewer = render(<RoomControls {...base} mode="viewer" canOpenUp={false} />)
    expect(viewer.byLabel(copy.roomControls.microphone)).toHaveLength(0)
    expect(viewer.byLabel(copy.roomControls.camera)).toHaveLength(0)
    expect(viewer.byLabel(copy.roomControls.participants)).toHaveLength(1)
    expect(viewer.byLabel(copy.roomControls.leave)).toHaveLength(1)
    const visitor = render(<RoomControls {...base} mode="visitor" canOpenUp={false} />)
    expect(visitor.byType('Pressable')).toHaveLength(1)
    expect(visitor.byLabel(copy.roomControls.leave)).toHaveLength(1)
  })

  it('presses call back to the room', () => {
    const pressed: string[] = []
    const screen = render(
      <RoomControls
        {...base}
        onMic={() => pressed.push('mic')}
        onOpenUp={() => pressed.push('openUp')}
        onLeave={() => pressed.push('leave')}
      />,
    )
    screen.press(copy.roomControls.microphone)
    screen.pressText(copy.openUp)
    screen.press(copy.roomControls.leave)
    expect(pressed).toEqual(['mic', 'openUp', 'leave'])
  })
})
