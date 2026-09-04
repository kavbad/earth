/**
 * SCREEN 20's list companion: every Live, friend, Place and Moment in the box, under its section
 * heading, reachable by tap — the accessible way to the map's objects (spec §77).
 */
import { fixtures } from '@earth/api/testing'
import { MapObjectsDtoSchema } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { mapCopy } from '@/features/earth/copy'
import { toMarkers } from '@/features/earth/state/markers'
import { render } from '@/test/render'

import { MapObjectsList, rowsFor } from './MapObjectsList'

const markers = toMarkers(MapObjectsDtoSchema.parse(fixtures.mapObjects()))
const empty = { lives: [], places: [], friends: [], moments: [] }
const noop = () => undefined

const props = {
  onClose: noop,
  onOpenLive: noop,
  onFocusFriend: noop,
  onFocusPlace: noop,
  onOpenMoment: noop,
}

describe('MapObjectsList (SCREEN 20)', () => {
  it('renders every marker under its section heading', () => {
    const screen = render(<MapObjectsList open markers={markers} {...props} />)
    const text = screen.text()
    for (const heading of Object.values(mapCopy.sections)) expect(text).toContain(heading)
    expect(rowsFor(markers)).toHaveLength(
      markers.lives.length +
        markers.friends.length +
        markers.places.length +
        markers.moments.length +
        4,
    )
    for (const live of markers.lives) expect(text).toContain(live.title)
    for (const friend of markers.friends) expect(text).toContain(friend.displayName)
    for (const place of markers.places) expect(text).toContain(place.name)
  })

  it('opens the Live that was tapped', () => {
    const opened: string[] = []
    const [live] = markers.lives
    if (live === undefined) throw new Error('fixture has no Live')
    const screen = render(
      <MapObjectsList
        open
        markers={markers}
        {...props}
        onOpenLive={(marker) => opened.push(marker.roomId)}
      />,
    )
    screen.pressText(`${live.title}${mapCopy.participants(live.participantCount)}`)
    expect(opened).toEqual([live.roomId])
  })

  it('says the box is empty rather than showing a blank sheet', () => {
    const screen = render(<MapObjectsList open markers={empty} {...props} />)
    expect(screen.text()).toContain(mapCopy.nothingHere)
  })
})
