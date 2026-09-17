/**
 * SCREEN 02 → 21: Home's Search control. Universal search has no tab of its own, and the
 * zero-friends "Add people you actually know" row disappears the moment a member has one friend
 * — so this header link is the only persistent way in, and it must carry the destination and a
 * name.
 *
 * `next/link` resolves its own copy of React here (the workspace hoists three), which the
 * renderer cannot drive; the link is stood in for by the `<a>` it renders in the browser.
 */
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { SEARCH_PATH, searchRoute } from '../profile/routes'
import { SearchButton } from './SearchButton'
import { feedCopy } from './copy'

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

describe('SearchButton', () => {
  it('links to SCREEN 21 with an accessible name', () => {
    const html = renderToStaticMarkup(<SearchButton />)
    expect(html).toContain(`href="${searchRoute()}"`)
    expect(html).toContain(`href="${SEARCH_PATH}"`)
    expect(html).toContain(`aria-label="${feedCopy.openSearch}"`)
  })

  it('takes no state, so nothing about the viewer can hide it', () => {
    expect(SearchButton).toHaveLength(0)
    expect(renderToStaticMarkup(<SearchButton />)).toBe(renderToStaticMarkup(<SearchButton />))
  })
})
