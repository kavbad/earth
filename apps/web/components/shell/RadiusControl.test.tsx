import { copy } from '@earth/ui'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { RadiusControlView, radiusOptions } from './RadiusControl'

const humanAvailability = {
  friends: 'available',
  neighborhood: 'available',
  city: 'available',
  world: 'available',
} as const

const visitorAvailability = {
  friends: 'claim',
  neighborhood: 'claim',
  city: 'disabled',
  world: 'available',
} as const

describe('RadiusControlView', () => {
  it('renders the four radii as text tabs in spec order with the selected one underlined', () => {
    const html = renderToStaticMarkup(
      <RadiusControlView
        value="friends"
        availability={humanAvailability}
        onSelect={() => undefined}
      />,
    )
    expect(html).toContain('role="tablist"')
    const labels = [...html.matchAll(/role="tab"[^>]*>([A-Za-z]+)</g)].map((m) => m[1])
    expect(labels).toEqual(['Friends', 'Neighborhood', 'City', 'World'])
    expect(html).toMatch(/aria-selected="true"[^>]*>Friends</)
    expect((html.match(/aria-selected="true"/g) ?? []).length).toBe(1)
    // The selected item is primary text; the others secondary — never a filled segment.
    expect(html).toContain('text-text-primary')
    expect(html).toContain('text-text-secondary')
    expect(html).not.toContain('bg-earth-accent')
  })

  it('shows World selected for a Visitor and marks a flag-disabled radius', () => {
    const html = renderToStaticMarkup(
      <RadiusControlView
        value="world"
        availability={visitorAvailability}
        onSelect={() => undefined}
      />,
    )
    expect(html).toMatch(/aria-selected="true"[^>]*>World</)
    expect(html).toMatch(/aria-disabled="true"[^>]*>City</)
    expect(html).not.toMatch(/aria-disabled="true"[^>]*>Friends</)
  })

  it('uses the canonical scope labels', () => {
    expect(radiusOptions(humanAvailability).map((o) => o.label)).toEqual([
      copy.scopes.friends,
      copy.scopes.neighborhood,
      copy.scopes.city,
      copy.scopes.world,
    ])
  })
})
