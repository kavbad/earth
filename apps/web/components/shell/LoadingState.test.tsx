import { copy } from '@earth/ui'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { OnlineContext } from '../../lib/providers/OfflineProvider'
import { LoadingState } from './LoadingState'

describe('LoadingState (spec §107)', () => {
  it('renders the placeholder while online', () => {
    const html = renderToStaticMarkup(
      <LoadingState>
        <span data-skeleton="1" />
      </LoadingState>,
    )
    expect(html).toContain('data-skeleton')
    expect(html).not.toContain(copy.waitingForConnection)
  })

  it('says "Waiting for connection" instead of a skeleton while offline', () => {
    const html = renderToStaticMarkup(
      <OnlineContext.Provider value={false}>
        <LoadingState>
          <span data-skeleton="1" />
        </LoadingState>
      </OnlineContext.Provider>,
    )
    expect(html).not.toContain('data-skeleton')
    expect(html).toContain(copy.waitingForConnection)
    expect(html).toContain('role="status"')
  })
})
