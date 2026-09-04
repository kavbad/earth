import { copy } from '@earth/ui'
import { describe, expect, it } from 'vitest'

import { render } from '@/test/render'

import { ClaimSheetView } from './ClaimSheet'

describe('ClaimSheetView (SCREEN 01)', () => {
  it('renders the sheet copy verbatim with both actions', () => {
    const screen = render(
      <ClaimSheetView open onClaim={() => undefined} onDismiss={() => undefined} />,
    )
    expect(screen.byType('Modal')).toHaveLength(1)
    expect(screen.text()).toContain(copy.claimToJoinConversation)
    expect(screen.text()).toContain(copy.claimYourPlace)
    expect(screen.text()).toContain(copy.notNow)
  })

  it('renders nothing while closed', () => {
    const screen = render(
      <ClaimSheetView open={false} onClaim={() => undefined} onDismiss={() => undefined} />,
    )
    expect(screen.renderer.toJSON()).toBeNull()
  })
})
