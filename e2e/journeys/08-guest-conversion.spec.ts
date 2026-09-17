/**
 * E2E 8 — Guest conversion (spec §116): Guest ends call → Claim CTA → group-anchored membership.
 *
 * The journey starts where E2E 7 leaves off, and makes that Guest session itself so it depends on
 * nothing but the seeds' absence: A claims a place, starts the group video (SCREEN 14) and shares
 * the room link from the "more" sheet; a second browser with no account and no session opens that
 * `/live/<token>` link and joins as a Guest (SCREEN 17 → 18).
 *
 * Then the conversion the spec cares about:
 *
 * 1. The Guest leaves the room. SCREEN 19 / spec §100: no giant signup modal — one small optional
 *    screen, "Good hanging out. Claim your place if you want to stay connected on Earth.", with
 *    "Claim my place" and "Done".
 * 2. "Claim my place" opens the claim gate at `/claim?entry=guest_room` — "Earth starts with your
 *    people." (spec §44), carrying the conversion context in the URL.
 * 3. The gate is group-anchored (`GROUP_ANCHORED_CLAIM_REQUIRED`, spec §118/§128): there is no
 *    "Continue without a group" control anywhere in it — not on the gate, not behind "Join a
 *    group", not on the optional group-name step. The only ways on are a group.
 * 4. "Start a group" → the optional name → a one-time code for an address Earth has never seen →
 *    identity → Human Pass (the `mock` provider) → "You're on Earth." → the group's conversation
 *    (SCREEN 10). The Guest is now a Human, in the same browser, with one identity.
 * 5. That Human exists publicly: their profile renders at `/u/<handle>` with their name and handle.
 *
 * Everyone here is made by this journey (`runId()` addresses), so the seeded fixtures are
 * untouched and two runs never collide.
 */
import { type Page, expect, test } from '@playwright/test'

import { expectToast, expectVisibleCopy } from '../fixtures/assertions'
import { MEDIA_PERMISSIONS, closeAll, newGuest, newPerson } from '../fixtures/contexts'
import { chatCopy, copy, roomCopy, webCopy } from '../fixtures/copy'
import { createHumanViaClaim, finishClaim, uniqueEmail, uniqueName } from '../fixtures/people'

const ROOM_URL = /\/rooms\/[0-9a-f-]{36}$/
const CONVERSATION_URL = /\/chats\/[0-9a-f-]{36}$/
const CLAIM_GATE_URL = /\/claim\?entry=guest_room$/
/** `roomInviteRoute` in `@earth/domain`: `/live/<token>` (SCREEN 17). */
const GUEST_LINK = /^https?:\/\/[^/]+\/live\/[A-Za-z0-9_-]+$/

/** Minting a token, connecting to LiveKit and publishing the fake devices. */
const MEDIA_TIMEOUT_MS = 30_000
/** `ROOM_POLL_INTERVAL_MS` (3 s) is the fallback cadence for the other side's room state. */
const ROOM_STATE_TIMEOUT_MS = 15_000

/**
 * "Continue without a group" is the one door group-anchoring closes (spec §128). Asserted as
 * copy, not as a control: a link, a row or a quiet button would all be a way around the group.
 */
async function expectNoWayPastTheGroup(page: Page): Promise<void> {
  await expect(page.getByText(webCopy.continueWithoutGroup)).toHaveCount(0)
  await expect(page.getByRole('button', { name: webCopy.continueWithoutGroup })).toHaveCount(0)
  await expect(page.getByRole('link', { name: webCopy.continueWithoutGroup })).toHaveCount(0)
}

test('E2E 8 — Guest conversion', async ({ browser }) => {
  // A shares the room link, which copies it — a permission like any other.
  const a = await newPerson(browser, {
    permissions: [...MEDIA_PERMISSIONS, 'clipboard-read', 'clipboard-write'],
  })
  // No account, no session, no Earth cookie: a browser that arrives on a link (spec §34).
  const guest = await newGuest(browser)

  const groupName = uniqueName('Crew')
  const nameA = uniqueName('Ada')
  const guestName = uniqueName('Gus')
  // The claim is a new Human: an address Earth has never seen, and their own group.
  const claimedEmail = uniqueEmail('converted')
  const claimedName = uniqueName('Nia')
  const claimedGroup = uniqueName('Kitchen')

  try {
    // ------------------------------------------------------------------ A, a room, a room link
    await createHumanViaClaim(a.page, {
      email: uniqueEmail('a'),
      displayName: nameA,
      intent: 'start_group',
      groupName,
    })

    // Spec §54: with no active room the composer's camera button starts the group video.
    await a.page.getByRole('button', { name: chatCopy.startVideo }).click()
    await a.page.waitForURL(ROOM_URL)
    await expect(a.page.getByRole('group', { name: roomCopy.you })).toBeVisible({
      timeout: MEDIA_TIMEOUT_MS,
    })

    // SCREEN 14 "more" → "Share link": the Guest link goes to the clipboard.
    await a.page.getByRole('button', { name: copy.roomControls.more }).click()
    await a.page.getByRole('button', { name: copy.shareLink }).click()
    await expectToast(a.page, roomCopy.linkCopied)
    const roomLink = (await a.page.evaluate(() => navigator.clipboard.readText())).trim()
    expect(roomLink).toMatch(GUEST_LINK)
    // The link Earth mints (`app_settings.web_origin`) points back at this Earth, so the Guest
    // below opens exactly what A shared instead of a rewritten address.
    expect(new URL(roomLink).origin).toBe(new URL(a.page.url()).origin)

    // ------------------------------------------------------------------ the Guest session
    await guest.page.goto(roomLink)
    // SCREEN 17: the preview names the room, then "Join as Guest" — no account asked for.
    await expect(guest.page.getByRole('heading', { name: groupName })).toBeVisible()
    await guest.page.getByRole('button', { name: copy.joinAsGuest }).click()

    await guest.page.getByRole('textbox', { name: copy.yourName }).fill(guestName)
    await guest.page.getByRole('button', { name: copy.join, exact: true }).click()

    // SCREEN 18: in the room, on A's stage, with A's tile in front of them.
    await expect(guest.page.getByRole('group', { name: nameA, exact: true })).toBeVisible({
      timeout: MEDIA_TIMEOUT_MS,
    })
    // A Guest is named as one, on both sides (spec §128: Guest is not Human).
    await expect(
      a.page.getByRole('group', { name: `${guestName} (${copy.guest})`, exact: true }),
    ).toBeVisible({ timeout: ROOM_STATE_TIMEOUT_MS })

    // ------------------------------------------------------------------ 1. the Guest leaves
    await guest.page.getByRole('button', { name: copy.roomControls.leave }).click()

    // SCREEN 19 — small and optional, exactly two ways on.
    await expectVisibleCopy(guest.page, copy.guestPostRoom)
    const claimCta = guest.page.getByRole('button', { name: copy.claimMyPlace })
    await expect(claimCta).toBeVisible()
    await expect(guest.page.getByRole('button', { name: copy.done })).toBeVisible()

    // ------------------------------------------------------------------ 2. the claim gate
    await claimCta.click()
    await guest.page.waitForURL(CLAIM_GATE_URL)
    await expect(guest.page.getByRole('heading', { name: copy.claimGate })).toBeVisible()

    // ------------------------------------------------------------------ 3. group-anchored
    await expectNoWayPastTheGroup(guest.page)
    // Behind "Join a group" there is an invite field and still no way past a group.
    await guest.page.getByRole('button', { name: copy.joinGroup }).click()
    await expect(guest.page.getByRole('textbox', { name: webCopy.inviteLinkLabel })).toBeVisible()
    await expectNoWayPastTheGroup(guest.page)
    await guest.page.getByRole('button', { name: webCopy.back }).click()

    // ------------------------------------------------------------------ 4. the claim itself
    await guest.page.getByRole('button', { name: copy.startGroup }).click()
    await expect(guest.page.getByRole('heading', { name: copy.optionalGroupName })).toBeVisible()
    await expectNoWayPastTheGroup(guest.page)
    await guest.page.getByRole('textbox', { name: webCopy.groupNameLabel }).fill(claimedGroup)
    await guest.page.getByRole('button', { name: webCopy.continue }).click()

    // Code → identity → Human Pass → "You're on Earth." → the group's conversation (spec §45–§49).
    const human = await finishClaim(guest.page, {
      email: claimedEmail,
      displayName: claimedName,
      groupName: claimedGroup,
    })

    // SCREEN 10: the chat is open, with the group's name and something to write in.
    await expect(guest.page).toHaveURL(CONVERSATION_URL)
    await expect(
      guest.page.getByRole('link', { name: `${claimedGroup} · ${chatCopy.openInfo}` }),
    ).toBeVisible()
    await expect(guest.page.getByRole('textbox', { name: copy.messagePlaceholder })).toBeVisible()

    // ------------------------------------------------------------------ 5. a Human now exists
    expect(human.handle).toMatch(/^[a-z0-9_]{3,24}$/)
    await guest.page.goto(`/u/${human.handle}`)
    await expect(
      guest.page.getByRole('heading', { name: claimedName, exact: true }).first(),
    ).toBeVisible()
    await expectVisibleCopy(guest.page, `@${human.handle}`)
  } finally {
    await closeAll(a, guest)
  }
})
