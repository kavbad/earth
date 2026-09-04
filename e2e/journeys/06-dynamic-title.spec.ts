/**
 * E2E 6 — Dynamic Live title (spec §116): A goes Live to Friends, C sees `<A> is live`, B joins
 * on camera, and C's Live home becomes `<A> + <B> are live` on its own.
 *
 * Three Humans, each anchored in their own group (spec §44), then the friendships the audience is
 * made of (spec §58: the union of the friendship graphs of the consenting publishers):
 * C ↔ A, B ↔ A and B ↔ C, every one of them through SCREEN 22's own buttons.
 *
 * 1. A taps the camera in their group's conversation (spec §57) and lands on camera in the room.
 * 2. A opens the room up — "Open up → Friends", and "Who can join → Friends" so a friend who is
 *    not in the group may join. Opening up *is* A's consent (ARCHITECTURE §10: the moderator's own
 *    `audience_consent_level` is raised by `room_set_visibility`), and with A the only publisher
 *    nothing is left pending: the room's audience line reads "Friends" straight away.
 * 3. C's Live home at the Friends radius shows one card titled exactly `<A> is live` — the
 *    `roomTitle` / `liveTitle` form of `@earth/domain`, which `@earth/ui`'s `copy.liveTitle`
 *    mirrors character for character — pointing at A's room.
 * 4. B finds the same card, opens it (a viewer first, spec §59), asks to join on camera, accepts
 *    SCREEN 16's consent line, and publishes.
 * 5. C's page — never reloaded, never touched — re-titles the same card `<A> + <B> are live`
 *    within 15 s.
 *
 * Everyone here is minted by this run (`runId()` addresses and names), so the journey is
 * independent of the seeds and of every other journey.
 */
import { type Locator, type Page, expect, test } from '@playwright/test'

import { closeAll, newPerson } from '../fixtures/contexts'
import { chatCopy, copy, profileCopy, roomCopy } from '../fixtures/copy'
import { createHumanViaClaim, uniqueEmail, uniqueName } from '../fixtures/people'

const ROOM_URL = /\/rooms\/[0-9a-f-]{36}$/

/** Minting a token, connecting to the local LiveKit and publishing the fake camera. */
const MEDIA_TIMEOUT_MS = 30_000
/** The other side's room state (`ROOM_POLL_INTERVAL_MS` is the fallback cadence). */
const ROOM_STATE_TIMEOUT_MS = 15_000
/** Spec §116 step: the Live title must follow a new publisher within 15 s, with no reload. */
const LIVE_TITLE_TIMEOUT_MS = 15_000

/** Every face on stage is one `ParticipantTile` — a group named after the person (SCREEN 14). */
function tileFor(page: Page, name: string): Locator {
  return page.getByRole('group', { name, exact: true })
}

/** The one Live card carrying `title` on SCREEN 13 (the row is the link into the room). */
function liveCard(page: Page, title: string): Locator {
  return page.getByRole('link', { name: title })
}

/**
 * What being on camera looks like from outside: the participant controls report microphone and
 * camera on (only true once the LiveKit tracks are published) and the person's own tile carries
 * a video track rather than the fallback avatar.
 */
async function expectOnCamera(page: Page): Promise<void> {
  await expect(
    page.getByRole('button', { name: copy.roomControls.camera, pressed: true }),
  ).toBeVisible({
    timeout: MEDIA_TIMEOUT_MS,
  })
  await expect(
    page.getByRole('button', { name: copy.roomControls.microphone, pressed: true }),
  ).toBeVisible({ timeout: MEDIA_TIMEOUT_MS })
  await expect(tileFor(page, roomCopy.you).locator('video')).toBeVisible({
    timeout: MEDIA_TIMEOUT_MS,
  })
  for (const line of [roomCopy.connecting, copy.reconnecting, copy.couldntReconnect]) {
    await expect(page.getByText(line, { exact: true })).toHaveCount(0)
  }
}

/** SCREEN 22: "Add Friend" on someone's profile, until the button reads "Requested". */
async function askToBeFriends(page: Page, handle: string): Promise<void> {
  await page.goto(`/u/${handle}`)
  await page.getByRole('button', { name: copy.profileActions.addFriend }).click()
  await expect(page.getByRole('button', { name: profileCopy.requested })).toBeVisible()
}

/** SCREEN 22: "Accept" the request waiting on their profile, until the button reads "Friends". */
async function acceptFriendRequest(page: Page, handle: string): Promise<void> {
  await page.goto(`/u/${handle}`)
  await page.getByRole('button', { name: profileCopy.accept }).click()
  await expect(
    page.getByRole('button', { name: copy.profileActions.friends, exact: true }),
  ).toBeVisible()
}

test('E2E 6 — Dynamic Live title', async ({ browser }) => {
  const a = await newPerson(browser)
  const b = await newPerson(browser)
  const c = await newPerson(browser)

  const nameA = uniqueName('Ada')
  const nameB = uniqueName('Bo')
  const nameC = uniqueName('Cass')

  try {
    // ------------------------------------------------------------------ three Humans
    // Each claims their own place (spec §44–§49); none of them shares a group with the others, so
    // everything below travels on friendship alone.
    const [humanA, humanB, humanC] = await Promise.all([
      createHumanViaClaim(a.page, {
        email: uniqueEmail('a'),
        displayName: nameA,
        intent: 'start_group',
      }),
      createHumanViaClaim(b.page, {
        email: uniqueEmail('b'),
        displayName: nameB,
        intent: 'start_group',
      }),
      createHumanViaClaim(c.page, {
        email: uniqueEmail('c'),
        displayName: nameC,
        intent: 'start_group',
      }),
    ])

    // ------------------------------------------------------------------ the friendship graph
    // C ↔ A, B ↔ A, B ↔ C — asked for on one profile, accepted on the other (spec §20).
    await Promise.all([
      askToBeFriends(c.page, humanA.handle),
      (async () => {
        await askToBeFriends(b.page, humanA.handle)
        await askToBeFriends(b.page, humanC.handle)
      })(),
    ])
    await Promise.all([
      (async () => {
        await acceptFriendRequest(a.page, humanC.handle)
        await acceptFriendRequest(a.page, humanB.handle)
      })(),
      acceptFriendRequest(c.page, humanB.handle),
    ])

    // ------------------------------------------------------------------ A goes Live
    await a.page.goto(humanA.conversationUrl)
    await expect(a.page.getByRole('textbox', { name: copy.messagePlaceholder })).toBeVisible()
    await a.page.getByRole('button', { name: chatCopy.startVideo }).click()
    await a.page.waitForURL(ROOM_URL)
    const roomPath = new URL(a.page.url()).pathname
    await expectOnCamera(a.page)

    // SCREEN 15 — Open up → Friends, and let friends join, not only the group.
    await a.page.getByRole('button', { name: copy.openUp }).click()
    const openUp = a.page.getByRole('dialog', { name: copy.openUp })
    await expect(openUp).toBeVisible()
    await openUp
      .getByRole('group', { name: copy.openUp })
      .getByText(copy.visibility.friends, { exact: true })
      .click()
    await openUp
      .getByRole('group', { name: copy.whoCanJoin })
      .getByText(copy.joinPolicies.friends, { exact: true })
      .click()
    await a.page.getByRole('button', { name: roomCopy.applyVisibility }).click()
    // A is the only publisher and opening up records A's own consent, so it applies at once: the
    // sheet closes and the room's audience line reads "Friends" (SCREEN 14 header).
    await expect(openUp).toBeHidden()
    await expect(
      a.page.getByRole('banner').getByText(copy.visibility.friends, { exact: true }),
    ).toBeVisible()

    // ------------------------------------------------------------------ "<A> is live"
    // `copy.liveTitle` is `@earth/ui`'s mirror of `@earth/domain`'s `roomTitle` / `liveTitle`.
    const soloTitle = copy.liveTitle([nameA])
    expect(soloTitle).toBe(`${nameA} is live`)

    await Promise.all([c.page.goto('/live'), b.page.goto('/live')])
    // SCREEN 13 at the Friends radius, which is where a Human starts (spec §51).
    await expect(
      c.page.getByRole('tab', { name: copy.scopes.friends, selected: true }),
    ).toBeVisible()

    const cCard = liveCard(c.page, soloTitle)
    await expect(cCard).toBeVisible({ timeout: LIVE_TITLE_TIMEOUT_MS })
    await expect(cCard).toHaveAttribute('href', roomPath)
    await expect(c.page.getByText(soloTitle, { exact: true })).toBeVisible()

    // From here C's page is never touched again: no click, no reload, no navigation.
    let cNavigations = 0
    c.page.on('framenavigated', (frame) => {
      if (frame === c.page.mainFrame()) cNavigations += 1
    })

    // ------------------------------------------------------------------ B joins on camera
    const bCard = liveCard(b.page, soloTitle)
    await expect(bCard).toBeVisible({ timeout: LIVE_TITLE_TIMEOUT_MS })
    await bCard.click()
    await b.page.waitForURL(ROOM_URL)
    // The card opened A's room, not a second one.
    expect(new URL(b.page.url()).pathname).toBe(roomPath)

    // A viewer first (spec §59 "Default: viewer"): A is on stage, B is not.
    await expect(tileFor(b.page, nameA)).toBeVisible({ timeout: ROOM_STATE_TIMEOUT_MS })
    const joinThem = b.page.getByRole('button', { name: copy.joinThem })
    await expect(joinThem).toBeVisible()
    // A watching Human is nobody's business: C's card still names A alone (spec §60 privacy).
    await expect(c.page.getByText(soloTitle, { exact: true })).toBeVisible()

    await joinThem.click()
    await b.page
      .getByRole('dialog', { name: copy.joinThem })
      .getByRole('button', { name: copy.joinOnCamera })
      .click()

    // SCREEN 16 — the consent line names A's room and its audience, word for word.
    const consent = b.page.getByRole('dialog', { name: copy.consent(nameA, 'friends') })
    await expect(consent).toBeVisible()
    await consent.getByRole('button', { name: copy.joinOnCamera }).click()

    const joinedOnCameraAt = Date.now()
    await expectOnCamera(b.page)
    await expect(tileFor(b.page, nameA)).toBeVisible()

    // ------------------------------------------------------------------ "<A> + <B> are live"
    // Two viewers may see the two names in either order (spec §60); the plural form and both
    // names are the product fact.
    const bothTitle = copy.liveTitle([nameA, nameB])
    const bothTitleReversed = copy.liveTitle([nameB, nameA])
    expect(bothTitle).toBe(`${nameA} + ${nameB} are live`)
    expect(bothTitleReversed).toBe(`${nameB} + ${nameA} are live`)

    const retitled = c.page
      .getByText(bothTitle, { exact: true })
      .or(c.page.getByText(bothTitleReversed, { exact: true }))
    await expect(retitled).toBeVisible({ timeout: LIVE_TITLE_TIMEOUT_MS })
    expect(Date.now() - joinedOnCameraAt).toBeLessThan(LIVE_TITLE_TIMEOUT_MS)

    // It followed on its own — the page never navigated — and it is still the same room.
    expect(cNavigations).toBe(0)
    const bothNames = (await retitled.textContent()) ?? ''
    expect(bothNames).toContain(nameA)
    expect(bothNames).toContain(nameB)
    // Two people, so the plural form — never "<A> + <B> is live".
    expect(bothNames).toMatch(/ are live$/)
    await expect(
      liveCard(c.page, bothTitle).or(liveCard(c.page, bothTitleReversed)),
    ).toHaveAttribute('href', roomPath)
    // The single-person title is gone: the card was re-titled, not duplicated.
    await expect(c.page.getByText(soloTitle, { exact: true })).toHaveCount(0)
  } finally {
    await closeAll(a, b, c)
  }
})
