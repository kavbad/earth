import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { SegmentedText } from './SegmentedText'

const options = [
  { key: 'a', label: 'Alpha' },
  { key: 'b', label: 'Beta' },
] as const

describe('SegmentedText (spec §93)', () => {
  it('is a plain text row: no filled segment, an understated indicator on the selected item', () => {
    const html = renderToStaticMarkup(
      <SegmentedText label="Radius" options={[...options]} value="a" onSelect={() => undefined} />,
    )
    expect(html).toContain('role="tablist"')
    expect(html).toMatch(/aria-selected="true"[^>]*>Alpha</)
    expect(html).toContain('text-text-primary')
    expect(html).toContain('text-text-secondary')
    // The indicator is the token border width, never a filled background behind the labels.
    expect(html).toContain('h-(--earth-border-indicator)')
    expect(html).toContain('bg-transparent')
    expect(html).not.toContain('bg-subtle-fill')
    expect(html).not.toContain('rounded-medium')
  })

  it('speaks as a radio group when it is a single-choice field, not a set of tabs', () => {
    const html = renderToStaticMarkup(
      <SegmentedText
        label="For how long"
        role="radiogroup"
        options={[...options]}
        value="b"
        onSelect={() => undefined}
      />,
    )
    expect(html).toContain('role="radiogroup"')
    expect(html).toContain('aria-label="For how long"')
    expect(html).toMatch(/aria-checked="true"[^>]*>Beta</)
    expect(html).toMatch(/aria-checked="false"[^>]*>Alpha</)
    expect(html).not.toContain('role="tab"')
    expect(html).not.toContain('aria-selected')
  })
})
