import { copy } from '@earth/ui'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ConsentSheet } from './ConsentSheet'
import { RoomHeader } from './RoomHeader'

describe('ConsentSheet (SCREEN 16)', () => {
  it('renders the exact consent copy and the three choices in order', () => {
    const html = renderToStaticMarkup(
      <ConsentSheet open initiatorName="Xavier" level="world" onChoose={() => undefined} onClose={() => undefined} />,
    )
    expect(html).toContain(
      "Xavier&#x27;s room is visible to World. If you join on camera, people on Earth may see that you&#x27;re here.",
    )
    const order = [copy.joinOnCamera, copy.joinAudioOnly, copy.justWatch].map((label) => html.indexOf(`<span>${label}</span>`))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('falls back to "Someone" when the initiator is unknown', () => {
    const html = renderToStaticMarkup(
      <ConsentSheet open initiatorName={null} level="friends" onChoose={() => undefined} onClose={() => undefined} />,
    )
    expect(html).toContain('Someone&#x27;s room is visible to Friends.')
  })
})

describe('RoomHeader (SCREEN 14 top)', () => {
  it('shows the context, the small Live mark, the audience and viewers', () => {
    const html = renderToStaticMarkup(
      <RoomHeader title="Weekend Crew" visibility="group" pendingVisibility="friends" watchingCount={3} />,
    )
    expect(html).toContain('<h1 class="truncate text-section">Weekend Crew</h1>')
    expect(html).toContain(`aria-label="${copy.tabs.live}"`)
    expect(html).toContain('Group → Friends')
    expect(html).toContain('3 watching')
    expect(html).not.toContain('border-live')
  })
})
