/**
 * E2E 7 — Guest (spec §116): an Earth Human shares a room link → a browser Guest joins without an
 * account. The critical acquisition surface (spec §112, SCREEN 17–18; "Between another feature and
 * better Live join latency: choose latency", §XXVI).
 *
 * 1. A claims a place, starts the group video from the composer and is on camera in `/rooms/<id>`.
 * 2. A opens `more` → `Share link`. The room invite is minted server-side and copied to the
 *    clipboard; the journey takes the token out of that link (the link's origin is the product's
 *    `web_origin`, the local stack's rooms live at `/live/<token>` on the app under test).
 * 3. A second browser context with no session at all — no cookies, no account — opens
 *    `/live/<token>`. The preview names A (the faces and "Shared by …"), then "Join as Guest" →
 *    "Your name" → "Join".
 * 4. The Guest is in the room: connected to LiveKit (publishing audio, subscribed to A's camera)
 *    with two tiles. The whole thing is timed from the moment the link is opened — spec §112's
 *    target is under 15 s; the journey logs what it measured and fails over 30 s.
 * 5. A's participants list shows the Guest with the subtle "Guest" tag (SCREEN 18), and the Guest
 *    has no `Open up` control and no invite control anywhere — a Guest never widens a room and
 *    never brings anyone in.
 *
 * Everyone here is made by this journey (`runId()` addresses and names), so it never touches the
 * seeded fixtures and two runs never collide.
 */
import { type Locator, type Page, expect, test } from '@playwright/test'

import { MEDIA_PERMISSIONS, closeAll, newGuest, newPerson } from '../fixtures/contexts'
import { chatCopy, copy, roomCopy } from '../fixtures/copy'
import { createHumanViaClaim, runId, uniqueEmail, uniqueName } from '../fixtures/people'

const ROOM_URL = /\/rooms\/[0-9a-f-]{36}$/
/** `<web_origin>/live/<token>` — what `room_invite_create` returns (spec §112). */
const ROOM_INVITE_URL = /^https?:\/\/[^/]+\/live\/[A-Za-z0-9_-]+$/

/** Minting a token, connecting to LiveKit and publishing the fake camera. */
const MEDIA_TIMEOUT_MS = 30_000
/** `ROOM_POLL_INTERVAL_MS` (3 s) is the fallback cadence for the other side's room state. */
const ROOM_STATE_TIMEOUT_MS = 15_000
/** Spec §112: "link tap to conversation in <15 seconds under healthy network conditions". */
const GUEST_JOIN_TARGET_MS = 15_000
/** What this journey fails on. Slower than the target so a loaded CI box is not a false failure. */
const GUEST_JOIN_BUDGET_MS = 30_000

/** Every face on stage is one `ParticipantTile` — a group named after the person (SCREEN 14). */
function tiles(page: Page): Locator {
  return page.getByRole('group')
}

function tileFor(page: Page, name: string): Locator {
  return page.getByRole('group', { name, exact: true })
}

/** A Guest's own tile says "You" and still carries the tag: `You (Guest)` (SCREEN 18). */
function guestTileName(name: string): string {
  return `${name} (${copy.guest})`
}

/**
 * `more` → `Share link` (SCREEN 14 controls, spec §35): the room invite lands on the clipboard
 * with the "Link copied" toast, and — when the browser refuses the clipboard — in a field to copy
 * by hand. Both are the product's own paths; the journey reads whichever one happened.
 */
async function shareRoomLink(page: Page): Promise<string> {
  await page.getByRole('button', { name: copy.roomControls.more }).click()
  const sheet = page.getByRole('dialog', { name: copy.roomControls.more })
  await expect(sheet).toBeVisible()
  await sheet.getByRole('button', { name: copy.shareLink }).click()

  const copied = page.getByRole('status').getByText(roomCopy.linkCopied, { exact: true })
  const manual = sheet.getByRole('textbox', { name: roomCopy.linkReady })
  await expect(copied.or(manual)).toBeVisible()
  const url =
    (await manual.count()) > 0
      ? await manual.inputValue()
      : await page.evaluate(() => navigator.clipboard.readText())

  // Escape closes the sheet the way a person does (`<dialog>` cancel → onClose).
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden()
  return url.trim()
}

test('E2E 7 — Guest', async ({ browser }) => {
  // Sharing the room link copies it, which is a permission like any other.
  const a = await newPerson(browser, {
    permissions: [...MEDIA_PERMISSIONS, 'clipboard-read', 'clipboard-write'],
  })
  // No session, no account, no storage: that is all it takes to be a Guest (spec §34).
  const guest = await newGuest(browser)

  const groupName = uniqueName('Crew')
  const nameA = uniqueName('Ada')
  const guestName = `${copy.guest} ${runId()}`

  try {
    // ---------------------------------------------------------------- A is in a room
    await createHumanViaClaim(a.page, {
      email: uniqueEmail('a'),
      displayName: nameA,
      intent: 'start_group',
      groupName,
    })

    // Spec §54: with no active room the composer's camera button starts the group video.
    await a.page.getByRole('button', { name: chatCopy.startVideo }).click()
    await a.page.waitForURL(ROOM_URL)
    await expect(
      a.page.getByRole('button', { name: copy.roomControls.camera, pressed: true }),
    ).toBeVisible({ timeout: MEDIA_TIMEOUT_MS })
    await expect(tileFor(a.page, roomCopy.you).locator('video')).toBeVisible({
      timeout: MEDIA_TIMEOUT_MS,
    })
    await expect(tiles(a.page)).toHaveCount(1)

    // ---------------------------------------------------------------- A shares the room link
    const inviteUrl = await shareRoomLink(a.page)
    expect(inviteUrl).toMatch(ROOM_INVITE_URL)
    const token = new URL(inviteUrl).pathname.split('/').pop() ?? ''
    expect(token).not.toBe('')

    // ---------------------------------------------------------------- the Guest opens the link
    const openedAt = Date.now()
    await guest.page.goto(`/live/${token}`)

    // SCREEN 17: the preview names who is there and who shared it — no signup wall in sight.
    await expect(guest.page.getByRole('img', { name: nameA, exact: true })).toBeVisible()
    await expect(guest.page.getByText(roomCopy.invitedBy(nameA), { exact: true })).toBeVisible()
    await expect(guest.page.getByRole('heading', { name: groupName })).toBeVisible()
    await expect(guest.page.getByRole('button', { name: copy.joinAsGuest })).toBeVisible()

    // "Join as Guest" → "Your name" → "Join". Two taps and a name, exactly as the spec says.
    await guest.page.getByRole('button', { name: copy.joinAsGuest }).click()
    await guest.page.getByRole('textbox', { name: copy.yourName }).fill(guestName)
    await guest.page.getByRole('button', { name: copy.join, exact: true }).click()

    // ---------------------------------------------------------------- the Guest is in the room
    // Connected to LiveKit: publishing audio (the microphone control reports it) and subscribed
    // to A's camera, with both faces on stage.
    await expect(tileFor(guest.page, guestTileName(roomCopy.you))).toBeVisible({
      timeout: MEDIA_TIMEOUT_MS,
    })
    await expect(tileFor(guest.page, nameA)).toBeVisible({ timeout: MEDIA_TIMEOUT_MS })
    await expect(
      guest.page.getByRole('button', { name: copy.roomControls.microphone, pressed: true }),
    ).toBeVisible({ timeout: MEDIA_TIMEOUT_MS })
    await expect(tiles(guest.page)).toHaveCount(2)
    const joinMs = Date.now() - openedAt

    // Spec §112's target is 15 s; the journey records what it measured either way.
    const measured = `link tap → in the room: ${joinMs} ms (spec target ${GUEST_JOIN_TARGET_MS} ms)`
    test.info().annotations.push({ type: 'guest-join', description: measured })
    console.log(`[E2E 7 — Guest] ${measured}`)
    expect(joinMs).toBeLessThan(GUEST_JOIN_BUDGET_MS)

    // The media really flows: A's camera track renders on the Guest's stage.
    await expect(tileFor(guest.page, nameA).locator('video')).toBeVisible({
      timeout: MEDIA_TIMEOUT_MS,
    })
    for (const line of [roomCopy.connecting, copy.reconnecting, copy.couldntReconnect]) {
      await expect(guest.page.getByText(line, { exact: true })).toHaveCount(0)
    }

    // ---------------------------------------------------------------- A sees the Guest, tagged
    const guestTile = tileFor(a.page, guestTileName(guestName))
    await expect(guestTile).toBeVisible({ timeout: ROOM_STATE_TIMEOUT_MS })
    await expect(tiles(a.page)).toHaveCount(2)
    // The Guest's audio reaches A: a tile whose microphone is not being heard carries the muted
    // marker, and this one does not.
    await expect(guestTile.getByRole('img', { name: copy.roomControls.microphone })).toHaveCount(
      0,
      { timeout: ROOM_STATE_TIMEOUT_MS },
    )

    await a.page.getByRole('button', { name: copy.roomControls.participants }).click()
    const participants = a.page.getByRole('dialog', { name: copy.roomControls.participants })
    await expect(participants).toBeVisible()
    // The row carrying the Guest's name is the row carrying the tag (SCREEN 18: "subtle Guest
    // next to name"), and A — a Human — is not tagged.
    const guestRow = participants.getByText(guestName, { exact: true }).locator('..')
    await expect(guestRow.getByText(copy.guest, { exact: true })).toBeVisible()
    await expect(participants.getByText(nameA, { exact: true })).toBeVisible()
    await expect(participants.getByText(copy.guest, { exact: true })).toHaveCount(1)
    await a.page.keyboard.press('Escape')
    await expect(participants).toBeHidden()

    // ---------------------------------------------------------------- what a Guest cannot do
    // A — the initiator — has the control in this very room, so its absence below is about the
    // Guest and not about the room (spec §58).
    await expect(a.page.getByRole('button', { name: copy.openUp })).toBeVisible()
    // No Open up: a Guest never expands a room's visibility (SCREEN 18).
    await expect(guest.page.getByRole('button', { name: copy.openUp })).toHaveCount(0)

    // And no invite control: the same `more` sheet that gave A "Share link" gives the Guest only
    // report and leave — no share, no Guests toggle, no End room.
    await guest.page.getByRole('button', { name: copy.roomControls.more }).click()
    const guestMore = guest.page.getByRole('dialog', { name: copy.roomControls.more })
    await expect(guestMore).toBeVisible()
    await expect(guestMore.getByRole('button', { name: copy.safety.report })).toBeVisible()
    await expect(guestMore.getByRole('button', { name: copy.leave })).toBeVisible()
    await expect(guestMore.getByRole('button', { name: copy.shareLink })).toHaveCount(0)
    await expect(guestMore.getByRole('button', { name: copy.safety.disableGuests })).toHaveCount(0)
    await expect(guestMore.getByRole('button', { name: copy.safety.endRoom })).toHaveCount(0)
    await expect(guest.page.getByText(copy.shareLink, { exact: true })).toHaveCount(0)
  } finally {
    await closeAll(a, guest)
  }
})
