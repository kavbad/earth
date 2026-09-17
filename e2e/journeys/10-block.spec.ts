/**
 * E2E 10 — Block (spec §116): A blocks B → B cannot DM, discover A's Live, or receive A's
 * location. Unblocking is deliberately not part of this journey.
 *
 * Spec §21 is the rule the journey is really about: a block overrides feed eligibility, search
 * visibility, Live discovery, messaging and location visibility, and no feature may bypass it.
 * §56 adds the part people have to understand: a shared group keeps working — the block does not
 * remove either Human from it — so the confirmation says so before anything happens.
 *
 * 1. A and B claim their own places (SCREEN 22) and become friends: A asks, B accepts.
 * 2. A opens a direct conversation with B (SCREEN 22 `Message`), and from its composer takes
 *    `Add → Here → Share from Earth` to the map, where the sheet is already addressed to B:
 *    `Share with <B>` → `1 hour` → `Share` (spec §75 — bounded, never forever).
 * 3. A starts their group's Live and opens it up to Friends (spec §57–§58). A is the only person
 *    on camera, so nothing is pending: the room is a Friends Live at once.
 * 4. B, a friend, has all of it: A's marker on the Earth map (Friends), `<A> is live` on Live
 *    home, the direct conversation, and A in `New chat`'s search.
 * 5. A blocks B from B's profile — `More → Block`, confirmed with the group-coexistence copy.
 *    A's Live stays live in A's other tab, so everything B loses below is the block, not the room
 *    ending.
 * 6. B now: cannot open a DM with A (A is absent from `New chat`'s search, and the direct
 *    conversation answers `This conversation isn't available.`), Live home no longer shows A's
 *    Live, the Earth map (Friends) has no marker for A, and A's profile reads as unavailable.
 *
 * Both people are made by this journey through the real claim UI (`runId()` addresses), so it
 * never touches the seeds and two runs never collide.
 */
import { type Locator, type Page, expect, test } from '@playwright/test'

import { MEDIA_PERMISSIONS, closeAll, newPerson } from '../fixtures/contexts'
import {
  chatCopy,
  copy,
  locationCopy,
  mapCopy,
  profileCopy,
  roomCopy,
  safetyCopy,
} from '../fixtures/copy'
import { expectToast } from '../fixtures/assertions'
import { createHumanViaClaim, uniqueEmail, uniqueName } from '../fixtures/people'

const CONVERSATION_URL = /\/chats\/[0-9a-f-]{36}$/
const ROOM_URL = /\/rooms\/[0-9a-f-]{36}$/

/** SCREEN 13 — Live Home. SCREEN 20 — Earth. SCREEN 09 — New chat. */
const LIVE_HOME = '/live'
const EARTH = '/earth'
const NEW_CHAT = '/chats/new'
/** `DEEP_LINK_PATHS.profile` — SCREEN 22 at `/@handle` (`next.config.ts` rewrites it to `/u`). */
const profilePath = (handle: string): string => `/@${handle}`

/** Where A is while sharing: one fixed position, so the degraded marker is deterministic. */
const A_POSITION = { latitude: 40.7128, longitude: -74.006 }

/** Minting a token, connecting to LiveKit and publishing the fake camera. */
const MEDIA_TIMEOUT_MS = 30_000
/** The other side's discovery surfaces (`GET /api/live`, `map_objects`) settling. */
const DISCOVERY_TIMEOUT_MS = 20_000

/** `map_objects` for the box B is looking at — the answer the map draws its markers from. */
function mapObjectsAnswer(page: Page): Promise<unknown> {
  return page.waitForResponse(
    (response) => response.url().includes('/rpc/map_objects') && response.status() === 200,
    { timeout: DISCOVERY_TIMEOUT_MS },
  )
}

/** SCREEN 20: a friend sharing where they are is one marker button, named for them. */
function friendMarker(page: Page, name: string): Locator {
  return page.getByRole('button', {
    name: `${name} · ${mapCopy.precision.approximate}`,
    exact: true,
  })
}

/** The map's objects as a list — the accessible companion of the markers. */
async function openMapList(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: mapCopy.listView, exact: true }).click()
  const sheet = page.getByRole('dialog', { name: mapCopy.listView })
  await expect(sheet).toBeVisible()
  return sheet
}

/** Publishing on camera: the controls report both tracks and the own tile carries live video. */
async function expectOnCamera(page: Page): Promise<void> {
  await expect(
    page.getByRole('button', { name: copy.roomControls.camera, pressed: true }),
  ).toBeVisible({ timeout: MEDIA_TIMEOUT_MS })
  await expect(
    page.getByRole('button', { name: copy.roomControls.microphone, pressed: true }),
  ).toBeVisible({ timeout: MEDIA_TIMEOUT_MS })
  await expect(
    page.getByRole('group', { name: roomCopy.you, exact: true }).locator('video'),
  ).toBeVisible({
    timeout: MEDIA_TIMEOUT_MS,
  })
}

/**
 * SCREEN 09: type a query into `New chat` and wait for the answer itself, not for a spinner —
 * the field is debounced, so the `search` call is what says the screen is showing an answer.
 */
async function searchPeople(page: Page, query: string): Promise<void> {
  await page.goto(NEW_CHAT)
  const field = page.getByRole('searchbox', { name: chatCopy.searchPeople })
  await expect(field).toBeVisible()
  const answered = page.waitForResponse(
    (response) => response.url().includes('/rpc/search') && response.status() === 200,
    { timeout: DISCOVERY_TIMEOUT_MS },
  )
  await field.fill(query)
  await answered
}

test('E2E 10 — Block', async ({ browser }) => {
  // A shares where they are, which needs the position permission as well as the media ones.
  const a = await newPerson(browser, { permissions: [...MEDIA_PERMISSIONS, 'geolocation'] })
  const b = await newPerson(browser)
  await a.context.setGeolocation(A_POSITION)

  const groupName = uniqueName('Crew')
  const nameA = uniqueName('Ada')
  const nameB = uniqueName('Bo')

  try {
    // ------------------------------------------------------------------ two Humans, two places
    const [humanA, humanB] = await Promise.all([
      createHumanViaClaim(a.page, {
        email: uniqueEmail('a'),
        displayName: nameA,
        intent: 'start_group',
        groupName,
      }),
      createHumanViaClaim(b.page, {
        email: uniqueEmail('b'),
        displayName: nameB,
        intent: 'start_group',
      }),
    ])
    // Their own groups: nothing but the friendship connects them.
    expect(humanB.conversationId).not.toBe(humanA.conversationId)

    // ------------------------------------------------------------------ A and B become friends
    // `/u/[handle]` is server-rendered from an anonymous read (spec §43), so the actions only
    // become the viewer's own once A's read lands: `Message` is the one that needs `canMessage`.
    await a.page.goto(profilePath(humanB.handle))
    await expect(a.page.getByRole('heading', { name: nameB, exact: true }).first()).toBeVisible()
    const messageButton = a.page.getByRole('button', {
      name: copy.profileActions.message,
      exact: true,
    })
    await expect(messageButton).toBeVisible()
    await a.page.getByRole('button', { name: copy.profileActions.addFriend, exact: true }).click()
    await expect(
      a.page.getByRole('button', { name: profileCopy.requested, exact: true }),
    ).toBeVisible()

    await b.page.goto(profilePath(humanA.handle))
    await expect(b.page.getByRole('heading', { name: nameA, exact: true }).first()).toBeVisible()
    await b.page.getByRole('button', { name: profileCopy.accept, exact: true }).click()
    await expect(
      b.page.getByRole('button', { name: copy.profileActions.friends, exact: true }),
    ).toBeVisible()

    // ------------------------------------------------------------------ A opens a DM with B
    await messageButton.click()
    await a.page.waitForURL(CONVERSATION_URL)
    const directUrl = a.page.url()
    expect(directUrl).not.toBe(humanA.conversationUrl)
    await expect(a.page.getByRole('textbox', { name: copy.messagePlaceholder })).toBeVisible()

    // --------------------------------------------------- A shares where they are with B, 1 hour
    // Spec §75: the chat hands off to the map; location writes never happen from a chat.
    await a.page.getByRole('button', { name: chatCopy.attach, exact: true }).click()
    await a.page.getByRole('button', { name: copy.composerActions.here, exact: true }).click()
    const here = a.page.getByRole('dialog', { name: copy.shareWith(nameB) })
    await expect(here).toBeVisible()
    await here.getByRole('link', { name: chatCopy.shareOnEarth, exact: true }).click()
    await a.page.waitForURL(/\/earth\?share=/)

    // The sheet opens already addressed to B — a friend, not a group.
    const shareSheet = a.page.getByRole('dialog', { name: copy.shareWith(nameB) })
    await expect(shareSheet).toBeVisible({ timeout: DISCOVERY_TIMEOUT_MS })
    const oneHour = shareSheet
      .getByRole('radiogroup', { name: locationCopy.durationLabel })
      .getByRole('radio', { name: copy.durations.oneHour, exact: true })
    await oneHour.check()
    await expect(oneHour).toBeChecked()
    await shareSheet.getByRole('button', { name: locationCopy.share, exact: true }).click()
    await expectToast(a.page, locationCopy.sharedWith(nameB))

    // ------------------------------------------------------------------ A's Live, open to Friends
    await a.page.goto(humanA.conversationUrl)
    await a.page.getByRole('button', { name: chatCopy.startVideo }).click()
    await a.page.waitForURL(ROOM_URL)
    await expectOnCamera(a.page)

    await a.page.getByRole('button', { name: copy.openUp, exact: true }).click()
    const openUp = a.page.getByRole('dialog', { name: copy.openUp })
    await expect(openUp).toBeVisible()
    await openUp
      .getByRole('group', { name: copy.openUp })
      .getByRole('radio', { name: copy.visibility.friends })
      .check()
    await openUp.getByRole('button', { name: roomCopy.applyVisibility }).click()
    // A is the only person on camera, so their own consent is the whole room's (spec §58): the
    // change applies at once and the sheet closes itself — nothing is left pending.
    await expect(openUp).toBeHidden()
    await expect(
      a.page.getByText(roomCopy.pendingVisibility(copy.visibility.friends), { exact: false }),
    ).toHaveCount(0)
    const audienceLine = a.page
      .getByRole('banner')
      .getByText(copy.visibility.friends, { exact: true })
    await expect(audienceLine).toBeVisible()

    // ------------------------------------------------------------------ what B has, before
    // Live home (SCREEN 13): the Friends radius, A named by the people on camera (spec §60).
    const liveTitle = copy.liveTitle([nameA])
    await b.page.goto(LIVE_HOME)
    await expect(
      b.page.getByRole('tab', { name: copy.scopes.friends, exact: true }),
    ).toHaveAttribute('aria-selected', 'true')
    await expect(b.page.getByRole('link', { name: liveTitle })).toBeVisible({
      timeout: DISCOVERY_TIMEOUT_MS,
    })

    // Earth (SCREEN 20): A's share reaches B, degraded to the precision A chose.
    const answeredBefore = mapObjectsAnswer(b.page)
    await b.page.goto(EARTH)
    await answeredBefore
    await expect(friendMarker(b.page, nameA)).toBeVisible({ timeout: DISCOVERY_TIMEOUT_MS })
    const listBefore = await openMapList(b.page)
    await expect(
      listBefore
        .getByRole('region', { name: mapCopy.sections.friends })
        .getByText(nameA, { exact: true }),
    ).toBeVisible()

    // The direct conversation is B's too, and A is in `New chat`'s search.
    await b.page.goto(directUrl)
    await expect(b.page.getByRole('textbox', { name: copy.messagePlaceholder })).toBeVisible()
    await searchPeople(b.page, nameA)
    await expect(b.page.getByRole('button', { name: nameA })).toBeVisible({
      timeout: DISCOVERY_TIMEOUT_MS,
    })

    // ------------------------------------------------------------------ A blocks B
    // A's room keeps running in the first tab: everything B loses is the block, not the room.
    const blockPage = await a.context.newPage()
    await blockPage.goto(profilePath(humanB.handle))
    await expect(blockPage.getByRole('heading', { name: nameB, exact: true }).first()).toBeVisible()
    await blockPage.getByRole('button', { name: copy.profileActions.more, exact: true }).click()
    const more = blockPage.getByRole('dialog', { name: copy.profileActions.more })
    await expect(more).toBeVisible()
    await more.getByRole('button', { name: copy.safety.block, exact: true }).click()

    // Spec §56: the confirmation says what a shared group does — both stay in it.
    await expect(more.getByText(profileCopy.blockConfirm(nameB), { exact: true })).toBeVisible()
    await expect(more.getByText(safetyCopy.blockGroups, { exact: true })).toBeVisible()
    await more.getByRole('button', { name: copy.safety.block, exact: true }).click()
    await expect(blockPage.getByText(profileCopy.blocked, { exact: true })).toBeVisible()
    await blockPage.close()

    // A is still live, to Friends, on camera.
    await expect(audienceLine).toBeVisible()
    await expect(
      a.page.getByRole('button', { name: copy.roomControls.camera, pressed: true }),
    ).toBeVisible()

    // ------------------------------------------------------------------ B: no DM with A
    // SCREEN 09 search: a blocked Human is not visible (spec §21 search visibility).
    await searchPeople(b.page, nameA)
    await expect(b.page.getByText(chatCopy.noPeopleFound, { exact: true })).toBeVisible({
      timeout: DISCOVERY_TIMEOUT_MS,
    })
    await expect(b.page.getByRole('button', { name: nameA })).toHaveCount(0)

    // The direct conversation they already had answers with the blocked state (spec §56).
    await b.page.goto(directUrl)
    await expect(b.page.getByText(chatCopy.conversationUnavailable, { exact: true })).toBeVisible()
    // Nothing can be written into it either: the composer is inert (spec §56 — B cannot send).
    await expect(b.page.getByRole('textbox', { name: copy.messagePlaceholder })).toBeDisabled()
    await expect(b.page.getByRole('button', { name: chatCopy.attach, exact: true })).toBeDisabled()

    // ------------------------------------------------------------------ B: no Live from A
    await b.page.goto(LIVE_HOME)
    await expect(b.page.getByText(roomCopy.nobodyLive('friends'), { exact: true })).toBeVisible({
      timeout: DISCOVERY_TIMEOUT_MS,
    })
    await expect(b.page.getByRole('link', { name: liveTitle })).toHaveCount(0)

    // ------------------------------------------------------------------ B: no marker for A
    const answered = mapObjectsAnswer(b.page)
    await b.page.goto(EARTH)
    await answered
    await expect(friendMarker(b.page, nameA)).toHaveCount(0)
    const listAfter = await openMapList(b.page)
    await expect(listAfter.getByText(nameA, { exact: true })).toHaveCount(0)

    // ------------------------------------------------------------------ B: A's profile is gone
    await b.page.goto(profilePath(humanA.handle))
    await expect(b.page.getByText(profileCopy.profileUnavailable, { exact: true })).toBeVisible({
      timeout: DISCOVERY_TIMEOUT_MS,
    })
    await expect(b.page.getByRole('button', { name: copy.profileActions.friends })).toHaveCount(0)
    await expect(b.page.getByRole('button', { name: copy.profileActions.addFriend })).toHaveCount(0)
  } finally {
    await closeAll(a, b)
  }
})
