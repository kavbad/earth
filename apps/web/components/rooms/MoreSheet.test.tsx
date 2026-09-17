import { copy } from '@earth/ui'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { MoreSheet, type MoreSheetProps } from './MoreSheet'

const noop = () => undefined
const base: MoreSheetProps = {
  open: true,
  canModerate: true,
  isGuest: false,
  guestsDisabled: false,
  shareUrl: null,
  onShare: noop,
  onToggleGuests: noop,
  onEnd: noop,
  onReport: noop,
  onLeave: noop,
  onClose: noop,
}

describe('MoreSheet (SCREEN 14 / 18)', () => {
  it('gives moderators the share link, Guests on/off and End room', () => {
    const html = renderToStaticMarkup(<MoreSheet {...base} />)
    expect(html).toContain(copy.shareLink)
    expect(html).toContain(copy.safety.disableGuests)
    expect(html).toContain(copy.safety.endRoom)
    expect(html).toContain(copy.safety.report)
    expect(html).toContain(copy.leave)
  })

  it('never lets a Guest invite, moderate or end the room — whatever the flags say', () => {
    const html = renderToStaticMarkup(<MoreSheet {...base} isGuest canModerate />)
    expect(html).not.toContain(copy.shareLink)
    expect(html).not.toContain(copy.safety.disableGuests)
    expect(html).not.toContain(copy.safety.endRoom)
    expect(html).toContain(copy.safety.report)
    expect(html).toContain(copy.leave)
  })
})
