/**
 * E2E 5 — Friend Live (spec §116): A + B active → Open up → Friends → C sees the Live card → C joins.
 *
 * The whole point of the journey is the cross-pollination rule of spec §58: a group's room opens
 * outward to the *union of the friendship graphs of its consenting camera participants*. C is a
 * friend of B and nothing else — not in the group, not a friend of A — so C may only discover the
 * room because B is on camera and said yes.
 *
 * 1. A starts a fresh group and brings B into it with the invite link; C claims their own place
 *    (SCREEN 22) and asks B to be friends, and B accepts.
 * 2. A taps the composer's camera button (spec §57) and lands on `/rooms/<id>` on camera; B joins
 *    from the group thread's `1 live · Join` line, on camera too.
 * 3. A opens SCREEN 15 — `Open up` → Friends, `Who can join: Friends`. B is on camera and has
 *    never consented beyond the group, so nothing changes yet: the sheet says it is opening up
 *    once everyone on camera agrees and names how many people it is waiting for (ARCHITECTURE §10).
 * 4. B gets SCREEN 16 — "<A>'s room is visible to Friends. …" — and accepts on camera. Only then
 *    does the room's audience become Friends.
 * 5. C's Live home in the Friends radius (SCREEN 13) shows the room as a card named for C:
 *    `<B> + <A> are live` — B first because B is C's friend (spec §60 participant-aware naming),
 *    and never the group's name, which C is not a member of.
 * 6. C opens the card, is a viewer first (spec §59), takes `Join them` → `Join audio`, accepts the
 *    same consent copy, and then appears in the participants list of both A and B.
 *
 * Everyone here is made by this journey through the real claim UI (`runId()` addresses), so it
 * never touches the seeds and two runs never collide.
 */
import { type Locator, type Page, expect, test } from '@playwright/test'

import { MEDIA_PERMISSIONS, closeAll, newPerson } from '../fixtures/contexts'
import { chatCopy, copy, profileCopy, roomCopy } from '../fixtures/copy'
import { createHumanViaClaim, uniqueEmail, uniqueName } from '../fixtures/people'

const CONVERSATION_URL = /\/chats\/[0-9a-f-]{36}$/
const CONVERSATION_INFO_URL = /\/chats\/[0-9a-f-]{36}\/info$/
const ROOM_URL = /\/rooms\/[0-9a-f-]{36}$/
const INVITE_LINK = /\/g\/[A-Za-z0-9_-]+$/

/** SCREEN 13 — Live Home. */
const LIVE_HOME = '/live'
/** `DEEP_LINK_PATHS.profile` — SCREEN 22 at `/@handle` (`next.config.ts` rewrites it to `/u`). */
const profilePath = (handle: string): string => `/@${handle}`

/** The other person's chat header learning about the room (spec §116 E2E 4 step 2). */
const ACTIVE_ROOM_TIMEOUT_MS = 10_000
/** Minting a token, connecting to LiveKit and publishing the fake camera. */
const MEDIA_TIMEOUT_MS = 30_000
/** `ROOM_POLL_INTERVAL_MS` (3 s) is the fallback cadence for the other side's room state. */
const ROOM_STATE_TIMEOUT_MS = 15_000
/** The journey's own budget: the Live card must be on C's Live home within 15 s. */
const DISCOVERY_TIMEOUT_MS = 15_000

/** Every face on stage is one `ParticipantTile` — a group named after the person (SCREEN 14). */
function tiles(page: Page): Locator {
  return page.getByRole('group')
}

function tileFor(page: Page, name: string): Locator {
  return page.getByRole('group', { name, exact: true })
}

/** The room's audience line in the SCREEN 14 header ("Live · Friends"). */
function headerAudience(page: Page, label: string): Locator {
  return page.getByRole('banner').getByText(label, { exact: true })
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

/** Everyone the room shows this person, by name (SCREEN 14 participants sheet). */
async function openParticipants(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: copy.roomControls.participants }).click()
  const sheet = page.getByRole('dialog', { name: copy.roomControls.participants })
  await expect(sheet).toBeVisible()
  return sheet
}

test('E2E 5 — Friend Live', async ({ browser }) => {
  // Sharing the invite link copies it, which is a permission like any other.
  const a = await newPerson(browser, {
    permissions: [...MEDIA_PERMISSIONS, 'clipboard-read', 'clipboard-write'],
  })
  const b = await newPerson(browser)
  const c = await newPerson(browser)

  const groupName = uniqueName('Crew')
  const nameA = uniqueName('Ada')
  const nameB = uniqueName('Bo')
  const nameC = uniqueName('Cy')

  try {
    // ------------------------------------------------------------------ A's group, and C alone
    // C claims their own place: C never joins A's group and only ever meets B as a friend.
    const [humanA, humanC] = await Promise.all([
      createHumanViaClaim(a.page, {
        email: uniqueEmail('a'),
        displayName: nameA,
        intent: 'start_group',
        groupName,
      }),
      createHumanViaClaim(c.page, {
        email: uniqueEmail('c'),
        displayName: nameC,
        intent: 'start_group',
      }),
    ])

    await a.page.getByRole('link', { name: `${groupName} · ${chatCopy.openInfo}` }).click()
    await a.page.waitForURL(CONVERSATION_INFO_URL)
    await a.page.getByRole('button', { name: copy.shareLink }).click()
    const linkButton = a.page.getByRole('button', { name: INVITE_LINK })
    await expect(linkButton).toBeVisible()
    const inviteUrl = ((await linkButton.textContent()) ?? '').trim()
    expect(inviteUrl).toMatch(INVITE_LINK)
    await a.page.goBack()
    await a.page.waitForURL(CONVERSATION_URL)

    const humanB = await createHumanViaClaim(b.page, {
      email: uniqueEmail('b'),
      displayName: nameB,
      intent: 'join_group',
      inviteToken: inviteUrl,
      groupName,
    })
    // One conversation, two people (spec §46 step 8); C is nowhere near it.
    expect(humanB.conversationId).toBe(humanA.conversationId)
    expect(humanC.conversationId).not.toBe(humanA.conversationId)

    // ------------------------------------------------------------------ C and B become friends
    // SCREEN 22: C asks, B accepts. Friend is not Follow (spec §128) — only the friendship is made.
    await c.page.goto(profilePath(humanB.handle))
    await expect(c.page.getByRole('heading', { name: nameB, exact: true }).first()).toBeVisible()
    await c.page.getByRole('button', { name: copy.profileActions.addFriend, exact: true }).click()
    await expect(
      c.page.getByRole('button', { name: profileCopy.requested, exact: true }),
    ).toBeVisible()

    await b.page.goto(profilePath(humanC.handle))
    await expect(b.page.getByRole('heading', { name: nameC, exact: true }).first()).toBeVisible()
    await b.page.getByRole('button', { name: profileCopy.accept, exact: true }).click()
    await expect(
      b.page.getByRole('button', { name: copy.profileActions.friends, exact: true }),
    ).toBeVisible()

    // B goes back to the group thread the way the tab bar takes them there.
    await b.page.goto(humanB.conversationUrl)
    await expect(b.page.getByRole('textbox', { name: copy.messagePlaceholder })).toBeVisible()

    // ------------------------------------------------------------------ A and B active on camera
    // Spec §57: no active room yet, so the camera button starts the group's video.
    await a.page.getByRole('button', { name: chatCopy.startVideo }).click()
    await a.page.waitForURL(ROOM_URL)
    const roomUrl = a.page.url()
    await expectOnCamera(a.page)
    // Visibility default for a group room: Group (spec §57).
    await expect(headerAudience(a.page, copy.visibility.group)).toBeVisible()

    const joinLine = b.page.getByRole('link', { name: copy.liveJoinLine(1) })
    await expect(joinLine).toBeVisible({ timeout: ACTIVE_ROOM_TIMEOUT_MS })
    await joinLine.click()
    await b.page.waitForURL(ROOM_URL)
    expect(b.page.url()).toBe(roomUrl)
    await b.page.getByRole('button', { name: copy.joinThem }).click()
    await b.page.getByRole('button', { name: copy.joinOnCamera, exact: true }).click()
    await expectOnCamera(b.page)
    await expect(tileFor(a.page, nameB)).toBeVisible({ timeout: ROOM_STATE_TIMEOUT_MS })
    await expect(tiles(a.page)).toHaveCount(2)

    // ------------------------------------------------------------------ A: Open up → Friends
    await a.page.getByRole('button', { name: copy.openUp, exact: true }).click()
    const openUp = a.page.getByRole('dialog', { name: copy.openUp })
    await expect(openUp).toBeVisible()
    const visibilityChoices = openUp.getByRole('group', { name: copy.openUp })
    const joinChoices = openUp.getByRole('group', { name: copy.whoCanJoin })

    await visibilityChoices.getByRole('radio', { name: copy.visibility.friends }).check()
    // Who can join: Friends — a group room could keep camera joins to its members, this one doesn't.
    const friendsMayJoin = joinChoices.getByRole('radio', { name: copy.joinPolicies.friends })
    await friendsMayJoin.check()
    await expect(friendsMayJoin).toBeChecked()
    await openUp.getByRole('button', { name: roomCopy.applyVisibility }).click()

    // Nothing widened yet: B is on camera and has not agreed (spec §58 step 5).
    await expect(
      openUp.getByText(roomCopy.pendingVisibility(copy.visibility.friends), { exact: false }),
    ).toBeVisible()
    await expect(openUp.getByText(roomCopy.pendingCount(1), { exact: false })).toBeVisible()

    // ------------------------------------------------------------------ B consents (SCREEN 16)
    const consentB = b.page.getByRole('dialog', { name: copy.consent(nameA, 'friends') })
    await expect(consentB).toBeVisible({ timeout: ROOM_STATE_TIMEOUT_MS })
    await consentB.getByRole('button', { name: copy.joinOnCamera, exact: true }).click()

    // Now the room is a Friends Live for both of them.
    await expect(
      openUp.getByText(roomCopy.pendingVisibility(copy.visibility.friends), { exact: false }),
    ).toHaveCount(0, { timeout: ROOM_STATE_TIMEOUT_MS })
    await openUp.getByRole('button', { name: copy.notNow }).click()
    await expect(headerAudience(a.page, copy.visibility.friends)).toBeVisible({
      timeout: ROOM_STATE_TIMEOUT_MS,
    })
    await expect(headerAudience(b.page, copy.visibility.friends)).toBeVisible({
      timeout: ROOM_STATE_TIMEOUT_MS,
    })
    await expectOnCamera(b.page)

    // ------------------------------------------------------------------ C's Live home finds it
    await c.page.goto(LIVE_HOME)
    // Spec §51: a Human's radius starts at Friends.
    await expect(
      c.page.getByRole('tab', { name: copy.scopes.friends, exact: true }),
    ).toHaveAttribute('aria-selected', 'true')
    // Participant-aware naming (spec §60): C's friend B is named first, then A.
    const cardTitle = copy.liveTitle([nameB, nameA])
    await expect(c.page.getByText(cardTitle, { exact: true })).toBeVisible({
      timeout: DISCOVERY_TIMEOUT_MS,
    })
    // C is not in A's group, so the card never names it.
    await expect(c.page.getByText(groupName, { exact: false })).toHaveCount(0)

    // ------------------------------------------------------------------ C joins with audio
    await c.page.getByRole('link', { name: cardTitle }).click()
    await c.page.waitForURL(ROOM_URL)
    expect(c.page.url()).toBe(roomUrl)

    // A viewer first (spec §59): both faces are there, C's is not.
    await expect(tileFor(c.page, nameB)).toBeVisible({ timeout: ROOM_STATE_TIMEOUT_MS })
    await expect(tileFor(c.page, nameA)).toBeVisible()
    await expect(tiles(c.page)).toHaveCount(2)

    await c.page.getByRole('button', { name: copy.joinThem }).click()
    await c.page.getByRole('button', { name: copy.joinAudio, exact: true }).click()
    // Joining a Friends Live means C's own friends may see C here: SCREEN 16 says so first.
    const consentC = c.page.getByRole('dialog', { name: copy.consent(nameA, 'friends') })
    await expect(consentC).toBeVisible()
    await consentC.getByRole('button', { name: copy.joinAudioOnly, exact: true }).click()

    // C is publishing audio: microphone on, no camera, and a tile of their own.
    await expect(
      c.page.getByRole('button', { name: copy.roomControls.microphone, pressed: true }),
    ).toBeVisible({ timeout: MEDIA_TIMEOUT_MS })
    await expect(
      c.page.getByRole('button', { name: copy.roomControls.camera, pressed: false }),
    ).toBeVisible()
    await expect(tileFor(c.page, roomCopy.you)).toBeVisible({ timeout: MEDIA_TIMEOUT_MS })
    await expect(c.page.getByRole('button', { name: copy.joinThem })).toHaveCount(0)

    // ------------------------------------------------------------------ A and B see C
    const participantsA = await openParticipants(a.page)
    await expect(participantsA.getByText(nameC, { exact: true })).toBeVisible({
      timeout: ROOM_STATE_TIMEOUT_MS,
    })
    await expect(participantsA.getByText(nameB, { exact: true })).toBeVisible()

    const participantsB = await openParticipants(b.page)
    await expect(participantsB.getByText(nameC, { exact: true })).toBeVisible({
      timeout: ROOM_STATE_TIMEOUT_MS,
    })
    await expect(participantsB.getByText(nameA, { exact: true })).toBeVisible()
  } finally {
    await closeAll(a, b, c)
  }
})
