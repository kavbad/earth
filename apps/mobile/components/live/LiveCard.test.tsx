/**
 * SCREEN 13 / spec §92: the Live row carries the participant-aware title, a quiet context line
 * and the small Live mark — never a colored border, never autoplay.
 */
import { fixtures } from '@earth/api/testing'
import { LiveCardDtoSchema } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { cardContextLine } from '@/features/rooms/state/live'
import { render } from '@/test/render'

import { LiveCard } from './LiveCard'

const card = (overrides: Parameters<typeof fixtures.liveCard>[0] = {}) =>
  LiveCardDtoSchema.parse(fixtures.liveCard(overrides))

describe('LiveCard (SCREEN 13)', () => {
  it('shows the participant-aware title and opens the room when pressed', () => {
    const live = card({ title: 'Xavier + 2 are live', participantCount: 3 })
    const opened: string[] = []
    const screen = render(<LiveCard card={live} onOpen={(c) => opened.push(c.title)} />)
    expect(screen.text()).toContain('Xavier + 2 are live')
    screen.press(live.title)
    expect(opened).toEqual(['Xavier + 2 are live'])
  })

  it('adds the context line to the row name when there is one', () => {
    const live = card({ contextTitle: 'Weekend Crew', visibility: 'world', areaName: 'Mission' })
    const line = cardContextLine(live)
    expect(line.length).toBeGreaterThan(0)
    const screen = render(<LiveCard card={live} onOpen={() => undefined} />)
    expect(screen.byLabel(`${live.title}, ${line}`)).toHaveLength(1)
    expect(screen.text()).toContain(line)
  })
})
