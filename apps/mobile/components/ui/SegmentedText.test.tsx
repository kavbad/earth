/**
 * Spec §93: the text row control — plain labels, one selected item, no filled segment. Mounted
 * for real, so the accessibility contract (`tablist` / `tab` / `selected` / `disabled`) is proven
 * on the device tree, not inferred.
 */
import { describe, expect, it } from 'vitest'

import { render } from '@/test/render'

import { SegmentedText } from './SegmentedText'

const options = [
  { key: 'a', label: 'Friends' },
  { key: 'b', label: 'City', state: 'disabled' as const },
  { key: 'c', label: 'World' },
]

describe('SegmentedText (spec §93)', () => {
  it('renders one tablist of tabs with exactly one selected', () => {
    const screen = render(
      <SegmentedText label="Radius" options={options} value="a" onSelect={() => undefined} />,
    )
    const tablist = screen.root.findAll(
      (node) => node.props['accessibilityRole'] === 'tablist' && typeof node.type === 'string',
    )
    expect(tablist).toHaveLength(1)
    expect(tablist[0]?.props['accessibilityLabel']).toBe('Radius')
    const tabs = screen.root.findAll(
      (node) => node.props['accessibilityRole'] === 'tab' && typeof node.type === 'string',
    )
    expect(tabs.map((tab) => tab.props['accessibilityLabel'])).toEqual(['Friends', 'City', 'World'])
    const selected = tabs.filter((tab) => tab.props['accessibilityState']?.selected === true)
    expect(selected).toHaveLength(1)
    expect(selected[0]?.props['accessibilityLabel']).toBe('Friends')
    expect(screen.text()).toContain('Friends')
  })

  it('selects on press and stays inert while disabled', () => {
    const picked: string[] = []
    const screen = render(
      <SegmentedText
        label="Radius"
        options={options}
        value="a"
        onSelect={(key) => picked.push(key)}
      />,
    )
    screen.press('World')
    expect(picked).toEqual(['c'])
    screen.press('City')
    expect(picked).toEqual(['c'])
    const city = screen.byLabel('City')[0]
    expect(city?.props['disabled']).toBe(true)
    expect(city?.props['accessibilityState']?.disabled).toBe(true)
  })
})
