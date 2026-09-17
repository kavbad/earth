import { copy } from '@earth/ui'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { webCopy } from '../../lib/copy'
import { LoadFailureView } from './LoadFailure'

const back = <a href="/home">{webCopy.backToEarth}</a>
const noop = () => undefined

/** `renderToStaticMarkup` escapes apostrophes; compare against the copy as it reads. */
const render = (online: boolean): string =>
  renderToStaticMarkup(<LoadFailureView online={online} onRetry={noop} back={back} />).replaceAll(
    '&#x27;',
    "'",
  )

describe('LoadFailureView (spec §107, §110)', () => {
  it('offers "Couldn\'t refresh" and "Try again" while online — never a page-sized error', () => {
    const html = render(true)
    expect(html).toContain(copy.couldntRefresh)
    expect(html).toContain(copy.tryAgain)
    expect(html).toContain(webCopy.backToEarth)
    expect(html).not.toContain(copy.waitingForConnection)
    expect(html).toContain('role="status"')
  })

  it('says "Waiting for connection" instead of an error while offline', () => {
    const html = render(false)
    expect(html).toContain(copy.waitingForConnection)
    expect(html).not.toContain(copy.couldntRefresh)
    expect(html).toContain(copy.tryAgain)
  })
})
