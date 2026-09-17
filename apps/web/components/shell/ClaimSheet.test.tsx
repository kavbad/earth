import { copy } from '@earth/ui'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ClaimSheetView } from './ClaimSheet'

describe('ClaimSheetView', () => {
  it('renders the SCREEN 01 sheet copy verbatim with both actions', () => {
    const html = renderToStaticMarkup(
      <ClaimSheetView open onClaim={() => undefined} onDismiss={() => undefined} />,
    )
    expect(html).toContain('<dialog')
    expect(html).toContain('aria-labelledby=')
    expect(html).toContain(copy.claimToJoinConversation)
    expect(html).toContain(`<span>${copy.claimYourPlace}</span>`)
    expect(html).toContain(`<span>${copy.notNow}</span>`)
    expect((html.match(/<button/g) ?? []).length).toBe(2)
  })
})
