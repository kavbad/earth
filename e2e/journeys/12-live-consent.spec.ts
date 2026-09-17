/**
 * E2E 12 — Live consent (spec §116): "World room → Human joining camera must acknowledge World
 * visibility."
 *
 * The invariant under test is spec §59/§128: audience permission is server-authoritative and a
 * Human never publishes into a wider audience by accident. Opening up is the moderator's own
 * consent, but it is *only* theirs — anyone who arrives afterwards and reaches for the camera
 * meets SCREEN 16 first, in the exact words of `@earth/ui`'s `copy.consent`, and "Just watch" is
 * always an answer: it leaves them a viewer with nothing published.
 *
 * 1. A starts a group and B claims their own place; B asks A to be friends and A accepts, so the
 *    two are the friends the journey names — and B still discovers the room the public way.
 * 2. A taps the composer's camera button (spec §57) and lands on `/rooms/<id>` on camera. The
 *    room is a group room, so its audience is Group (ARCHITECTURE §10 defaults).
 * 3. A opens SCREEN 15 — `Open up` → World, `Who can join: Anyone eligible`. A is the only person
 *    on camera and opening up is the moderator's own consent, so it applies at once: the header
 *    reads World and nothing is left pending.
 * 4. B's Live home at the World radius (SCREEN 13) shows the room — the World branch of
 *    `live_candidates` takes `visibility = 'world'` rooms only, so the card is proof the room
 *    really is public — and B opens it. Spec §59: a Human enters as a viewer.
 * 5. `Join them` → `Join on camera` shows SCREEN 16 with the exact consent line for A and World.
 *    While it is up, A's stage still has exactly one tile: nothing was published to ask.
 * 6. B chooses `Just watch`. B stays a viewer — no tile of their own, no camera control, the join
 *    bar still there — and A's stage is still one tile.
 * 7. B takes `Join them` → `Join on camera` again, meets the same consent copy, and accepts. Only
 *    now does B publish, and B's face appears on A's stage.
 *
 * Both people are made by this journey through the real claim UI (`runId()` addresses), so it
 * never touches the seeds and two runs never collide.
 */
import { type Locator, type Page, expect, test } from '@playwright/test'

import { closeAll, newPerson } from '../fixtures/contexts'
import { chatCopy, copy, profileCopy, roomCopy, webCopy } from '../fixtures/copy'
import { createHumanViaClaim, uniqueEmail, uniqueName } from '../fixtures/people'

const ROOM_URL = /\/rooms\/[0-9a-f-]{36}$/

/** SCREEN 13 — Live Home. */
const LIVE_HOME = '/live'
/** `DEEP_LINK_PATHS.profile` — SCREEN 22 at `/@handle` (`next.config.ts` rewrites it to `/u`). */
const profilePath = (handle: string): string => `/@${handle}`

/** Minting a token, connecting to LiveKit and publishing the fake camera. */
const MEDIA_TIMEOUT_MS = 30_000
/** `ROOM_POLL_INTERVAL_MS` (3 s) is the fallback cadence for the other side's room state. */
const ROOM_STATE_TIMEOUT_MS = 15_000
/** `LIVE_REFRESH_INTERVAL_MS` (10 s) is how often SCREEN 13 re-reads `GET /api/live`. */
const DISCOVERY_TIMEOUT_MS = 20_000

/** Every face on stage is one `ParticipantTile` — a group named after the person (SCREEN 14). */
function tiles(page: Page): Locator {
  return page.getByRole('group')
}

function tileFor(page: Page, name: string): Locator {
  return page.getByRole('group', { name, exact: true })
}

/** The room's audience line in the SCREEN 14 header ("Live · World"). */
function headerAudience(page: Page, label: string): Locator {
  return page.getByRole('banner').getByText(label, { exact: true })
}

/** SCREEN 16, by its exact `@earth/ui` sentence: the dialog is named by the consent copy itself. */
function consentSheet(page: Page, initiatorName: string): Locator {
  return page.getByRole('dialog', { name: copy.consent(initiatorName, 'world') })
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

/** SCREEN 14 viewer state: "Join them" → the media choice, which opens SCREEN 16 when it must. */
async function askToJoinOnCamera(page: Page): Promise<void> {
  await page.getByRole('button', { name: copy.joinThem }).click()
  const choice = page.getByRole('dialog', { name: copy.joinThem })
  await expect(choice).toBeVisible()
  await choice.getByRole('button', { name: copy.joinOnCamera, exact: true }).click()
}

/** Nobody but `expected` is on stage for this page, and nothing is published for `absent`. */
async function expectStage(page: Page, expected: number, absent?: string): Promise<void> {
  await expect(tiles(page)).toHaveCount(expected)
  if (absent !== undefined) await expect(tileFor(page, absent)).toHaveCount(0)
}

test('E2E 12 — Live consent', async ({ browser }) => {
  const a = await newPerson(browser)
  const b = await newPerson(browser)

  const groupName = uniqueName('Crew')
  const nameA = uniqueName('Ada')
  const nameB = uniqueName('Bo')

  try {
    // ------------------------------------------------------------------ A's group, B's own place
    // B never joins A's group: the only tie between them is the friendship made below, and the
    // only way B meets the room is the public World radius.
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
    expect(humanB.conversationId).not.toBe(humanA.conversationId)

    // ------------------------------------------------------------------ A and B become friends
    // SCREEN 22: B asks, A accepts. Friend is not Follow (spec §128) — only the friendship is made.
    await b.page.goto(profilePath(humanA.handle))
    await expect(b.page.getByRole('heading', { name: nameA, exact: true }).first()).toBeVisible()
    await b.page.getByRole('button', { name: copy.profileActions.addFriend, exact: true }).click()
    await expect(
      b.page.getByRole('button', { name: profileCopy.requested, exact: true }),
    ).toBeVisible()

    await a.page.goto(profilePath(humanB.handle))
    await expect(a.page.getByRole('heading', { name: nameB, exact: true }).first()).toBeVisible()
    await a.page.getByRole('button', { name: profileCopy.accept, exact: true }).click()
    await expect(
      a.page.getByRole('button', { name: copy.profileActions.friends, exact: true }),
    ).toBeVisible()

    // ------------------------------------------------------------------ A starts the room
    await a.page.goto(humanA.conversationUrl)
    await expect(a.page.getByRole('textbox', { name: copy.messagePlaceholder })).toBeVisible()
    // Spec §57: no active room yet, so the camera button starts the group's video.
    await a.page.getByRole('button', { name: chatCopy.startVideo }).click()
    await a.page.waitForURL(ROOM_URL)
    const roomUrl = a.page.url()
    await expectOnCamera(a.page)
    // Visibility default for a group room: Group (ARCHITECTURE §10).
    await expect(headerAudience(a.page, copy.visibility.group)).toBeVisible()
    await expectStage(a.page, 1)

    // ------------------------------------------------------------------ A: Open up → World
    await a.page.getByRole('button', { name: copy.openUp, exact: true }).click()
    const openUp = a.page.getByRole('dialog', { name: copy.openUp })
    await expect(openUp).toBeVisible()
    const visibilityChoices = openUp.getByRole('group', { name: copy.openUp })
    const joinChoices = openUp.getByRole('group', { name: copy.whoCanJoin })

    await visibilityChoices.getByRole('radio', { name: copy.visibility.world }).check()
    // A group room keeps "Who can join: Group" by default even at World; this one opens the seat.
    const anyoneMayJoin = joinChoices.getByRole('radio', { name: copy.joinPolicies.anyone })
    await anyoneMayJoin.check()
    await expect(anyoneMayJoin).toBeChecked()
    await openUp.getByRole('button', { name: roomCopy.applyVisibility }).click()

    // A is the only person on camera and opening up is the moderator's own consent (spec §58):
    // the change applies at once, the sheet closes, and nothing is left pending.
    await expect(openUp).toHaveCount(0, { timeout: ROOM_STATE_TIMEOUT_MS })
    await expect(headerAudience(a.page, copy.visibility.world)).toBeVisible({
      timeout: ROOM_STATE_TIMEOUT_MS,
    })

    // The room really kept both choices: World is where it is now, Anyone eligible is the seat.
    await a.page.getByRole('button', { name: copy.openUp, exact: true }).click()
    await expect(openUp).toBeVisible()
    await expect(
      openUp.getByRole('group', { name: copy.openUp }).getByRole('radio', {
        name: copy.visibility.world,
      }),
    ).toBeChecked()
    await expect(
      openUp.getByRole('group', { name: copy.whoCanJoin }).getByRole('radio', {
        name: copy.joinPolicies.anyone,
      }),
    ).toBeChecked()
    await expect(openUp.getByText(roomCopy.currentVisibility, { exact: true })).toBeVisible()
    await openUp.getByRole('button', { name: copy.notNow }).click()
    await expect(openUp).toHaveCount(0)
    await expectStage(a.page, 1)

    // ------------------------------------------------------------------ B finds it in World
    await b.page.goto(LIVE_HOME)
    const radius = b.page.getByRole('tablist', { name: webCopy.radiusLabel })
    // Spec §51: a Human's radius starts at Friends; the journey browses the public one.
    await expect(radius.getByRole('tab', { selected: true })).toHaveText(copy.scopes.friends)
    await radius.getByRole('tab', { name: copy.scopes.world, exact: true }).click()
    await expect(radius.getByRole('tab', { selected: true })).toHaveText(copy.scopes.world)

    // Only `visibility = 'world'` rooms reach the World radius, and B is in no group of A's, so
    // the card is named after the person publishing (spec §60), never after A's private group.
    const cardTitle = copy.liveTitle([nameA])
    await expect(b.page.getByText(cardTitle, { exact: true })).toBeVisible({
      timeout: DISCOVERY_TIMEOUT_MS,
    })
    await expect(b.page.getByText(groupName, { exact: false })).toHaveCount(0)
    await b.page.getByRole('link', { name: cardTitle }).click()
    await b.page.waitForURL(ROOM_URL)
    expect(b.page.url()).toBe(roomUrl)

    // A viewer first (spec §59): A's face is there, B's is not, and A sees a watcher.
    await expect(tileFor(b.page, nameA)).toBeVisible({ timeout: ROOM_STATE_TIMEOUT_MS })
    await expectStage(b.page, 1, roomCopy.you)
    await expect(a.page.getByRole('banner').getByText(roomCopy.watching(1))).toBeVisible({
      timeout: ROOM_STATE_TIMEOUT_MS,
    })
    await expectStage(a.page, 1, nameB)

    // ------------------------------------------------------------------ SCREEN 16, before anything
    await askToJoinOnCamera(b.page)
    const consent = consentSheet(b.page, nameA)
    await expect(consent).toBeVisible()
    // The sentence itself, verbatim from `@earth/ui` — A's name and the room's World audience.
    await expect(
      b.page.getByRole('heading', { name: copy.consent(nameA, 'world'), exact: true }),
    ).toBeVisible()
    for (const label of [copy.joinOnCamera, copy.joinAudioOnly, copy.justWatch]) {
      await expect(consent.getByRole('button', { name: label, exact: true })).toBeVisible()
    }
    // Nothing was published to ask the question: A's stage is still A alone.
    await expectStage(a.page, 1, nameB)

    // ------------------------------------------------------------------ "Just watch"
    await consent.getByRole('button', { name: copy.justWatch, exact: true }).click()
    await expect(consent).toHaveCount(0)

    // B is a viewer: no tile of their own, no camera control, the join bar still offered.
    await expectStage(b.page, 1, roomCopy.you)
    await expect(b.page.getByRole('button', { name: copy.roomControls.camera })).toHaveCount(0)
    await expect(b.page.getByRole('button', { name: copy.joinThem })).toBeVisible()
    // And A never saw a second face: declining consent published nothing.
    await expectStage(a.page, 1, nameB)

    // ------------------------------------------------------------------ Asked again, B accepts
    await askToJoinOnCamera(b.page)
    const consentAgain = consentSheet(b.page, nameA)
    await expect(consentAgain).toBeVisible()
    await consentAgain.getByRole('button', { name: copy.joinOnCamera, exact: true }).click()

    await expectOnCamera(b.page)
    await expect(b.page.getByRole('button', { name: copy.joinThem })).toHaveCount(0)

    // B's face on A's stage: the consent B gave is what put it there.
    await expect(tileFor(a.page, nameB)).toBeVisible({ timeout: ROOM_STATE_TIMEOUT_MS })
    await expect(tiles(a.page)).toHaveCount(2)
    await expect(tileFor(b.page, nameA)).toBeVisible()
    await expect(tiles(b.page)).toHaveCount(2)
  } finally {
    await closeAll(a, b)
  }
})
