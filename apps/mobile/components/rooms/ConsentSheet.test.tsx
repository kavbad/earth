/**
 * SCREEN 16: the consent line names the initiator and the audience, and the three choices are
 * Join on camera / Join audio only / Just watch — no hidden audience inheritance (spec §57).
 */
import { CONSENT_CHOICES, copy } from '@earth/ui'
import { describe, expect, it } from 'vitest'

import { render } from '@/test/render'

import { ConsentSheet } from './ConsentSheet'
import { roomCopy } from '@/features/rooms/copy'

describe('ConsentSheet (SCREEN 16)', () => {
  it('asks with the exact consent copy and offers the three choices in order', () => {
    const screen = render(
      <ConsentSheet
        open
        initiatorName="Xavier"
        level="world"
        onChoose={() => undefined}
        onClose={() => undefined}
      />,
    )
    const text = screen.text()
    expect(text).toContain(copy.consent('Xavier', 'world'))
    const positions = CONSENT_CHOICES.map((choice) => text.indexOf(choice.label))
    expect(positions.every((index) => index >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it('falls back to "someone" and hands the chosen media state back', () => {
    const chosen: string[] = []
    const screen = render(
      <ConsentSheet
        open
        initiatorName={null}
        level="friends"
        onChoose={(mediaState) => chosen.push(mediaState)}
        onClose={() => undefined}
      />,
    )
    expect(screen.text()).toContain(copy.consent(roomCopy.someone, 'friends'))
    const [first] = CONSENT_CHOICES
    if (first === undefined) throw new Error('no consent choices')
    screen.press(first.label)
    expect(chosen).toEqual([first.mediaState])
  })

  it('renders nothing while closed', () => {
    const screen = render(
      <ConsentSheet
        open={false}
        initiatorName="Xavier"
        level="world"
        onChoose={() => undefined}
        onClose={() => undefined}
      />,
    )
    expect(screen.renderer.toJSON()).toBeNull()
  })
})
