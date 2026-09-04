/**
 * The room's "more" sheet: share link, Guests on/off and End room for moderators only, report,
 * leave — and End room asks before it ends anything.
 */
import { copy } from '@earth/ui'
import { describe, expect, it } from 'vitest'

import { roomCopy } from '@/features/rooms/copy'
import { render } from '@/test/render'

import { MoreSheet, type MoreSheetProps } from './MoreSheet'

const noop = () => undefined
const base: MoreSheetProps = {
  open: true,
  canModerate: true,
  guestsDisabled: false,
  onShare: noop,
  onToggleGuests: noop,
  onEnd: noop,
  onReport: noop,
  onLeave: noop,
  onClose: noop,
}

describe('MoreSheet', () => {
  it('gives a moderator share, Guests, End room, report and leave', () => {
    const screen = render(<MoreSheet {...base} />)
    const text = screen.text()
    expect(text).toContain(copy.shareLink)
    expect(text).toContain(copy.safety.disableGuests)
    expect(text).toContain(copy.safety.endRoom)
    expect(text).toContain(copy.safety.report)
    expect(text).toContain(copy.leave)
  })

  it('hides the moderator rows from everyone else, and Guests behind its flag', () => {
    const plain = render(<MoreSheet {...base} canModerate={false} />)
    expect(plain.text()).not.toContain(copy.safety.endRoom)
    expect(plain.text()).not.toContain(copy.safety.disableGuests)
    expect(plain.text()).toContain(copy.safety.report)
    const flagOff = render(<MoreSheet {...base} guestsEnabled={false} />)
    expect(flagOff.text()).not.toContain(copy.safety.disableGuests)
    expect(flagOff.text()).toContain(copy.safety.endRoom)
  })

  it('confirms before ending the room', () => {
    let ended = 0
    const screen = render(<MoreSheet {...base} onEnd={() => (ended += 1)} />)
    screen.press(copy.safety.endRoom)
    expect(ended).toBe(0)
    expect(screen.text()).toContain(roomCopy.endRoomConfirm)
    screen.press(roomCopy.endRoomYes)
    expect(ended).toBe(1)
  })
})
