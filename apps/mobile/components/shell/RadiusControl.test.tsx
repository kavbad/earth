/**
 * Spec §51/§93: Friends · Neighborhood · City · World as one text row, in spec order, with the
 * Visitor's World selected and a flag-off radius inert. Mirrors apps/web's RadiusControl test.
 */
import { copy } from '@earth/ui'
import { describe, expect, it } from 'vitest'

import { render } from '@/test/render'

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

const tabsOf = (screen: ReturnType<typeof render>) =>
  screen.root.findAll(
    (node) => typeof node.type === 'string' && node.props['accessibilityRole'] === 'tab',
  )

describe('RadiusControlView', () => {
  it('renders the four radii in spec order with the selected one marked', () => {
    const screen = render(
      <RadiusControlView
        value="friends"
        availability={humanAvailability}
        onSelect={() => undefined}
      />,
    )
    const tabs = tabsOf(screen)
    expect(tabs.map((tab) => tab.props['accessibilityLabel'])).toEqual([
      'Friends',
      'Neighborhood',
      'City',
      'World',
    ])
    const selected = tabs.filter((tab) => tab.props['accessibilityState']?.selected === true)
    expect(selected).toHaveLength(1)
    expect(selected[0]?.props['accessibilityLabel']).toBe('Friends')
  })

  it('shows World selected for a Visitor and marks a flag-disabled radius', () => {
    const screen = render(
      <RadiusControlView
        value="world"
        availability={visitorAvailability}
        onSelect={() => undefined}
      />,
    )
    const tabs = tabsOf(screen)
    const state = (label: string) =>
      tabs.find((tab) => tab.props['accessibilityLabel'] === label)?.props['accessibilityState']
    expect(state('World')?.selected).toBe(true)
    expect(state('City')?.disabled).toBe(true)
    expect(state('Friends')?.disabled).toBe(false)
  })

  it('uses the canonical scope labels', () => {
    expect(radiusOptions(humanAvailability).map((option) => option.label)).toEqual([
      copy.scopes.friends,
      copy.scopes.neighborhood,
      copy.scopes.city,
      copy.scopes.world,
    ])
  })
})
