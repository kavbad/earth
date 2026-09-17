/**
 * Live pins on Earth — a room opened to the Neighborhood is on the map, positioned by its area
 * (Milestone 6, "the map shows Lives by area"; spec §52, §76, §92, SCREEN 20).
 *
 * Not one of spec §116's twelve. E2E 11 proves the radius half of the milestone and E2E 10 walks
 * the map's friend markers; this is the Live pin. A room reaches the map only through
 * `map_objects` (0590), which positions a Live at its Place or — for a room open to a
 * neighborhood or a city — at the centroid of the area it took from its host's context
 * (`earth.room_area_for`; spec §76: an area, never device coordinates).
 *
 * 1. A claims a place and a group. On Earth, `Use my location` resolves A's (fake) position in
 *    the Mission (`area_resolve` + `context_set`), and Home at Neighborhood now says `Mission`.
 * 2. A starts video from the group thread (SCREEN 14) and opens up to Neighborhood (SCREEN 15).
 *    A is the only person on camera, so their own consent is the room's and it applies at once.
 * 3. Ben — a seed Human whose context is the Mission, a stranger to A and no member of the
 *    group — opens Earth at Neighborhood. `map_objects` answers with the room at the Mission's
 *    centroid with `precision: 'neighborhood'`, and the map draws one pin for it.
 * 4. The pin is named for A, `<A> is live · 1 person`, never for the group: a private group's
 *    name is its members' (0998), and Ben is not one.
 *
 * A and the group are this journey's own (`runId()` addresses and names); Ben is read-only
 * (supabase/seed/README.md), and the journey leaves nothing behind in his account.
 */
import { type Locator, type Page, expect, test } from '@playwright/test'

import { MEDIA_PERMISSIONS, closeAll, newPerson } from '../fixtures/contexts'
import { chatCopy, copy, mapCopy, roomCopy, webCopy } from '../fixtures/copy'
import {
  FIXTURE_EMAILS,
  createHumanViaClaim,
  signInExisting,
  uniqueEmail,
  uniqueName,
} from '../fixtures/people'

const ROOM_URL = /\/rooms\/([0-9a-f-]{36})$/

/** SCREEN 02–05 and SCREEN 20. */
const HOME = '/home'
const EARTH = '/earth'
const conversationPath = (id: string): string => `/chats/${id}`

/**
 * The Mission's centroid as `0510_areas_base.sql` upserts it (`usa-ca-san-francisco-mission`):
 * where A stands, and where the room's pin must land once the room is open to the neighborhood.
 */
const MISSION = { name: 'Mission', lat: 37.7599, lng: -122.4148 } as const
/** The pin sits on the centroid itself; this only absorbs rounding on the way through JSON. */
const POSITION_TOLERANCE_DEG = 0.001

/** Minting a token, connecting to LiveKit and publishing the fake camera. */
const MEDIA_TIMEOUT_MS = 30_000
/** `area_resolve` + `context_set` after the fake position arrives, then the session refresh. */
const CONTEXT_TIMEOUT_MS = 15_000
/** The other side's discovery surface (`map_objects`) settling. */
const DISCOVERY_TIMEOUT_MS = 20_000
/** Leaving the room: the RPC, the LiveKit disconnect and the navigation away (E2E 4/5's cadence). */
const ROOM_STATE_TIMEOUT_MS = 15_000

/** One `map_objects` Live, as 0590 builds it. */
interface MapLive {
  readonly roomId: string
  readonly title: string
  readonly lat: number
  readonly lng: number
  readonly precision: string
  readonly participantCount: number
}

function livesOf(body: unknown): readonly MapLive[] {
  const lives = (body as { readonly lives?: unknown }).lives
  return Array.isArray(lives) ? (lives as MapLive[]) : []
}

/** `map_objects` for the box the page is looking at — the answer the map draws its markers from. */
function mapObjectsAnswer(page: Page): Promise<unknown> {
  return page.waitForResponse(
    (response) => response.url().includes('/rpc/map_objects') && response.status() === 200,
    { timeout: DISCOVERY_TIMEOUT_MS },
  )
}

/** The one radius control of a surface (spec §51, §93). */
function radiusControl(page: Page): Locator {
  return page.getByRole('tablist', { name: webCopy.radiusLabel })
}

async function switchRadius(page: Page, scope: keyof typeof copy.scopes): Promise<void> {
  await radiusControl(page).getByRole('tab', { name: copy.scopes[scope], exact: true }).click()
  await expect(radiusControl(page).getByRole('tab', { selected: true })).toHaveText(
    copy.scopes[scope],
  )
}

/** Every face on stage is one `ParticipantTile` — a group named after the person (SCREEN 14). */
function tileFor(page: Page, name: string): Locator {
  return page.getByRole('group', { name, exact: true })
}

/** Publishing on camera: the controls report both tracks and the own tile carries live video. */
async function expectOnCamera(page: Page): Promise<void> {
  await expect(
    page.getByRole('button', { name: copy.roomControls.camera, pressed: true }),
  ).toBeVisible({ timeout: MEDIA_TIMEOUT_MS })
  await expect(
    page.getByRole('button', { name: copy.roomControls.microphone, pressed: true }),
  ).toBeVisible({ timeout: MEDIA_TIMEOUT_MS })
  await expect(tileFor(page, roomCopy.you).locator('video')).toBeVisible({
    timeout: MEDIA_TIMEOUT_MS,
  })
}

test('Live pins on Earth — a room open to the Neighborhood is on the map, by area', async ({
  browser,
}) => {
  const a = await newPerson(browser, { permissions: [...MEDIA_PERMISSIONS, 'geolocation'] })
  await a.context.setGeolocation({ latitude: MISSION.lat, longitude: MISSION.lng })
  const ben = await newPerson(browser)

  const groupName = uniqueName('Crew')
  const nameA = uniqueName('Ada')

  try {
    // ---------------------------------------------------------------- A, standing in the Mission
    const humanA = await createHumanViaClaim(a.page, {
      email: uniqueEmail('a'),
      displayName: nameA,
      intent: 'start_group',
      groupName,
    })

    // `Use my location` needs the map (SCREEN 20) to be there first: its first `map_objects`
    // answer is the sign that the camera has settled.
    const earthReady = mapObjectsAnswer(a.page)
    await a.page.goto(EARTH)
    await earthReady
    const contextSet = a.page.waitForResponse(
      (response) =>
        response.url().includes('/rpc/context_resolve_and_set') && response.status() === 200,
      { timeout: CONTEXT_TIMEOUT_MS },
    )
    await a.page.getByRole('button', { name: mapCopy.useMyLocation, exact: true }).first().click()
    await contextSet
    // Home at Neighborhood names the area A is now in (SCREEN 03) — the context landed.
    await a.page.goto(HOME)
    await switchRadius(a.page, 'neighborhood')
    await expect(a.page.getByText(MISSION.name, { exact: true })).toBeVisible({
      timeout: CONTEXT_TIMEOUT_MS,
    })

    // ---------------------------------------------------------------- A on camera, open to the Neighborhood
    await a.page.goto(conversationPath(humanA.conversationId))
    await a.page.getByRole('button', { name: chatCopy.startVideo }).click()
    await a.page.waitForURL(ROOM_URL)
    const roomId = ROOM_URL.exec(a.page.url())?.[1] ?? ''
    expect(roomId).not.toBe('')
    await expectOnCamera(a.page)

    await a.page.getByRole('button', { name: copy.openUp, exact: true }).click()
    const openUp = a.page.getByRole('dialog', { name: copy.openUp })
    await expect(openUp).toBeVisible()
    await openUp
      .getByRole('group', { name: copy.openUp })
      .getByRole('radio', { name: copy.visibility.neighborhood })
      .check()
    await openUp.getByRole('button', { name: roomCopy.applyVisibility }).click()
    // A is the only person on camera, so their own consent is the whole room's (spec §58): the
    // change applies at once and the sheet closes itself.
    await expect(openUp).toBeHidden()
    await expect(
      a.page.getByRole('banner').getByText(copy.visibility.neighborhood, { exact: true }),
    ).toBeVisible()

    // ---------------------------------------------------------------- Ben, on Earth at Neighborhood
    await signInExisting(ben.page, FIXTURE_EMAILS.ben, { next: EARTH })
    // The answer that carries A's room — registered before the radius change that asks for it.
    const withRoom = ben.page.waitForResponse(
      async (response) =>
        response.url().includes('/rpc/map_objects') &&
        response.status() === 200 &&
        livesOf(await response.json()).some((live) => live.roomId === roomId),
      { timeout: DISCOVERY_TIMEOUT_MS },
    )
    await switchRadius(ben.page, 'neighborhood')
    const live = livesOf(await (await withRoom).json()).find((item) => item.roomId === roomId)
    expect(live).toBeDefined()
    if (live === undefined) return

    // Positioned by its area: the Mission's centroid, at neighborhood precision (spec §76).
    expect(live.precision).toBe('neighborhood')
    expect(Math.abs(live.lat - MISSION.lat)).toBeLessThan(POSITION_TOLERANCE_DEG)
    expect(Math.abs(live.lng - MISSION.lng)).toBeLessThan(POSITION_TOLERANCE_DEG)
    // Named for the person on camera, not for the private group Ben is no member of (0998).
    const title = `${nameA} is live`
    expect(live.title).toBe(title)
    expect(live.participantCount).toBe(1)

    // And drawn (SCREEN 20, spec §92): the room's own pin — or, when other Lives stand on the very
    // same spot, the one cluster there (`clusterLives`). Either way it is on the map.
    const pin = ben.page.getByRole('button', {
      name: mapCopy.openRoom(`${title} · ${mapCopy.participants(1)}`),
      exact: true,
    })
    const cluster = ben.page.getByRole('button', { name: /live here · Zoom in$/ })
    await expect(pin.or(cluster).first()).toBeVisible({ timeout: DISCOVERY_TIMEOUT_MS })

    // The map's List (SCREEN 20) is the same answer as rows: A's Live is under "Live", named for A,
    // with its one person — and the group's name is nowhere on Ben's screen.
    await ben.page.getByRole('button', { name: mapCopy.listView, exact: true }).click()
    const list = ben.page.getByRole('dialog', { name: mapCopy.listView })
    await expect(list).toBeVisible()
    const liveRow = list
      .getByRole('region', { name: copy.tabs.live })
      .getByText(title, { exact: true })
    await expect(liveRow).toBeVisible()
    await expect(ben.page.getByText(groupName, { exact: true })).toHaveCount(0)

    // A leaves. With nobody on camera the room is out of discovery at once, so a run that passed
    // leaves nothing behind on the map for the next one to cluster with.
    await a.page.getByRole('button', { name: copy.roomControls.leave, exact: true }).click()
    await expect(a.page).not.toHaveURL(ROOM_URL, { timeout: ROOM_STATE_TIMEOUT_MS })
  } finally {
    await closeAll(a, ben)
  }
})
