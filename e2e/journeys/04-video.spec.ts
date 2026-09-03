/**
 * E2E 4 — Video (spec §116): A starts a group call → B sees the active state → B joins.
 *
 * A starts a group and brings B into it with the invite link, so the two share one conversation
 * (SCREEN 10). From there the journey is the camera button and what it does to both people:
 *
 * 1. A taps the composer's camera button. Spec §54: with no active room it starts the group video,
 *    so A lands on `/rooms/<id>` (SCREEN 14) already on camera — one tile, the media connection
 *    live (Chromium's fake camera and microphone are published to the local LiveKit).
 * 2. B, still in the thread, gets the contextual header line of SCREEN 10 — `1 live · Join` —
 *    without touching the page.
 * 3. B taps it, arrives in the same room as a viewer (spec §59 "Default: viewer") and is offered
 *    "Join them"; B chooses "Join on camera".
 * 4. Both contexts settle on the same room with two tiles, each named — A's own as "You", the
 *    other by display name — and both are publishing.
 *
 * The group room's visibility is `group`, which is not discoverable beyond it, so nobody is asked
 * to consent here; SCREEN 16 belongs to E2E 12. Both people are made by this journey (`runId()`
 * addresses), so it never touches the seeds and two runs never collide.
 */
import { type Locator, type Page, expect, test } from '@playwright/test'

import { MEDIA_PERMISSIONS, closeAll, newPerson } from '../fixtures/contexts'
import { chatCopy, copy, roomCopy } from '../fixtures/copy'
import { createHumanViaClaim, uniqueEmail, uniqueName } from '../fixtures/people'

const CONVERSATION_URL = /\/chats\/[0-9a-f-]{36}$/
const CONVERSATION_INFO_URL = /\/chats\/[0-9a-f-]{36}\/info$/
const ROOM_URL = /\/rooms\/[0-9a-f-]{36}$/
const INVITE_LINK = /\/g\/[A-Za-z0-9_-]+$/

/** How long the other person's chat header may take to learn about the room (spec §116 step 2). */
const ACTIVE_ROOM_TIMEOUT_MS = 10_000
/** Minting a token, connecting to LiveKit and publishing the fake camera. */
const MEDIA_TIMEOUT_MS = 30_000
/** `ROOM_POLL_INTERVAL_MS` (3 s) is the fallback cadence for the other side's room state. */
const ROOM_STATE_TIMEOUT_MS = 15_000

/** Every face on stage is one `ParticipantTile` — a group named after the person (SCREEN 14). */
function tiles(page: Page): Locator {
  return page.getByRole('group')
}

function tileFor(page: Page, name: string): Locator {
  return page.getByRole('group', { name, exact: true })
}

/**
 * What "connected" looks like from outside: the person is publishing (the participant controls
 * report microphone and camera on, which only happens once the LiveKit tracks are published),
 * their own tile carries the live camera track, and the connection overlay — the one thing
 * `ConnectionOverlay` shows for every state except a connected one — is not there.
 */
async function expectConnectedOnCamera(page: Page): Promise<void> {
  await expect(
    page.getByRole('button', { name: copy.roomControls.camera, pressed: true }),
  ).toBeVisible({ timeout: MEDIA_TIMEOUT_MS })
  await expect(
    page.getByRole('button', { name: copy.roomControls.microphone, pressed: true }),
  ).toBeVisible({ timeout: MEDIA_TIMEOUT_MS })
  // The fake device is a real camera track: the tile renders video, not the fallback avatar.
  await expect(tileFor(page, roomCopy.you).locator('video')).toBeVisible({
    timeout: MEDIA_TIMEOUT_MS,
  })
  for (const line of [roomCopy.connecting, copy.reconnecting, copy.couldntReconnect]) {
    await expect(page.getByText(line, { exact: true })).toHaveCount(0)
  }
}

test('E2E 4 — Video', async ({ browser }) => {
  // Sharing the invite link copies it, which is a permission like any other.
  const a = await newPerson(browser, {
    permissions: [...MEDIA_PERMISSIONS, 'clipboard-read', 'clipboard-write'],
  })
  const b = await newPerson(browser)

  const groupName = uniqueName('Crew')
  const nameA = uniqueName('Ada')
  const nameB = uniqueName('Bo')

  try {
    // ---------------------------------------------------------------- A and B in one group
    const humanA = await createHumanViaClaim(a.page, {
      email: uniqueEmail('a'),
      displayName: nameA,
      intent: 'start_group',
      groupName,
    })

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
    // One conversation, two people (spec §46 step 8).
    expect(humanB.conversationId).toBe(humanA.conversationId)
    await expect(b.page.getByRole('textbox', { name: copy.messagePlaceholder })).toBeVisible()

    // B never reloads: the header has to learn about the room on its own.
    let reloads = 0
    b.page.on('framenavigated', (frame) => {
      if (frame === b.page.mainFrame()) reloads += 1
    })

    // ---------------------------------------------------------------- A starts the group video
    // Spec §54: no active room yet, so the camera button starts one.
    await a.page.getByRole('button', { name: chatCopy.startVideo }).click()
    await a.page.waitForURL(ROOM_URL)
    const roomUrl = a.page.url()

    // SCREEN 14: A is the initiator, on camera, alone — one tile, and it is A's own.
    await expect(tileFor(a.page, roomCopy.you)).toBeVisible()
    await expect(tiles(a.page)).toHaveCount(1)
    await expectConnectedOnCamera(a.page)

    // ---------------------------------------------------------------- B's header goes live
    const joinLine = b.page.getByRole('link', { name: copy.liveJoinLine(1) })
    await expect(joinLine).toBeVisible({ timeout: ACTIVE_ROOM_TIMEOUT_MS })
    expect(reloads).toBe(0)

    // ---------------------------------------------------------------- B joins from the chat
    await joinLine.click()
    await b.page.waitForURL(ROOM_URL)
    // The same room A started, not a second one.
    expect(b.page.url()).toBe(roomUrl)

    // A viewer first (spec §59): A is on stage, B is not, and the offer is "Join them".
    await expect(tileFor(b.page, nameA)).toBeVisible({ timeout: ROOM_STATE_TIMEOUT_MS })
    const joinThem = b.page.getByRole('button', { name: copy.joinThem })
    await expect(joinThem).toBeVisible()
    await expect(tiles(b.page)).toHaveCount(1)

    await joinThem.click()
    await b.page.getByRole('button', { name: copy.joinOnCamera }).click()

    // ---------------------------------------------------------------- two faces, both sides
    await expectConnectedOnCamera(b.page)
    await expect(tileFor(b.page, nameA)).toBeVisible()
    await expect(tiles(b.page)).toHaveCount(2)
    // The join bar is gone once B is publishing.
    await expect(b.page.getByRole('button', { name: copy.joinThem })).toHaveCount(0)

    await expect(tileFor(a.page, nameB)).toBeVisible({ timeout: ROOM_STATE_TIMEOUT_MS })
    await expect(tiles(a.page)).toHaveCount(2)
    await expect(tileFor(a.page, roomCopy.you)).toBeVisible()
  } finally {
    await closeAll(a, b)
  }
})
