import { copy } from '@earth/ui'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ConnectionOverlay } from './ConnectionOverlay'
import { roomCopy } from './copy'

const noop = () => undefined

/** renderToStaticMarkup escapes text, so compare copy the same way (see ConsentSheet.test.tsx). */
const escaped = (text: string): string =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll("'", '&#x27;')
    .replaceAll('"', '&quot;')

describe('ConnectionOverlay (spec §109)', () => {
  it('shows "Reconnecting…" while retrying, without actions', () => {
    const html = renderToStaticMarkup(
      <ConnectionOverlay status="reconnecting" detail={{}} onRetry={noop} onLeave={noop} />,
    )
    expect(html).toContain(escaped(copy.reconnecting))
    expect(html).not.toContain(`<span>${copy.tryAgain}</span>`)
  })

  it('offers "Try again" and "Leave" once reconnecting failed', () => {
    const html = renderToStaticMarkup(
      <ConnectionOverlay status="failed" detail={{}} onRetry={noop} onLeave={noop} />,
    )
    expect(html).toContain(escaped(copy.couldntReconnect))
    expect(html).toContain(`<span>${copy.tryAgain}</span>`)
    expect(html).toContain(`<span>${copy.leave}</span>`)
  })

  it('treats a drop nobody asked for like a failure, and a leave like nothing', () => {
    const dropped = renderToStaticMarkup(
      <ConnectionOverlay
        status="disconnected"
        detail={{ code: 'DUPLICATE_IDENTITY' }}
        onRetry={noop}
        onLeave={noop}
      />,
    )
    expect(dropped).toContain(escaped(copy.couldntReconnect))
    expect(dropped).toContain(`<span>${copy.tryAgain}</span>`)
    const left = renderToStaticMarkup(
      <ConnectionOverlay
        status="disconnected"
        detail={{ code: 'CLIENT_INITIATED' }}
        onRetry={noop}
        onLeave={noop}
      />,
    )
    expect(left).toBe('')
  })

  it('says "Connecting…" on the first connect and nothing once connected', () => {
    expect(
      renderToStaticMarkup(
        <ConnectionOverlay status="connecting" detail={{}} onRetry={noop} onLeave={noop} />,
      ),
    ).toContain(roomCopy.connecting)
    expect(
      renderToStaticMarkup(
        <ConnectionOverlay status="connected" detail={{}} onRetry={noop} onLeave={noop} />,
      ),
    ).toBe('')
  })
})
