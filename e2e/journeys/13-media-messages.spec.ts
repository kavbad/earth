/**
 * Media messages — a photo and a voice note, end to end (DOD-02).
 *
 * Not one of spec §116's twelve: the remainder of the messenger's definition of done (spec §53,
 * §54 — photos and voice notes in a thread). E2E 3 proves text, replies, reactions and read
 * receipts; this is the half that moves bytes. Two browser contexts in one group conversation,
 * exactly as E2E 3 sets them up:
 *
 * 1. A opens the composer's `+` (SCREEN 10) and takes "Photo or video" — the page's own file
 *    input, so the journey answers the real file chooser with a generated PNG
 *    (`fixtures/media.ts`). The screen reads the image's size, uploads it to the `media` bucket
 *    through the stack's Storage service and sends an `image` message.
 * 2. B's open thread shows the photo without a reload, and the bytes come back: the `<img>`
 *    resolves through the signed media route (`GET /api/media/:bucket/:key`, spec §104) to the
 *    48 × 32 image that was sent, not to a placeholder.
 * 3. A taps the microphone, records over Chromium's fake audio device (`MediaRecorder`, the
 *    composer's own recorder) and stops-and-sends. The note goes to the `voice` bucket and out as
 *    an `audio` message.
 * 4. B's thread shows the voice message named for A with its duration, and the `<audio>` element
 *    reaches HAVE_METADATA from the signed URL: what arrived is a playable recording.
 *
 * Everyone here is made by this journey (`runId()` addresses and names), so it never touches the
 * seeded fixtures and two runs never collide.
 */
import { type Locator, type Page, expect, test } from '@playwright/test'

import { MEDIA_PERMISSIONS, closeAll, newPerson } from '../fixtures/contexts'
import { chatCopy, copy } from '../fixtures/copy'
import { pngFile } from '../fixtures/media'
import { createHumanViaClaim, uniqueEmail, uniqueName } from '../fixtures/people'

const CONVERSATION_URL = /\/chats\/[0-9a-f-]{36}$/
const CONVERSATION_INFO_URL = /\/chats\/[0-9a-f-]{36}\/info$/
const INVITE_LINK = /\/g\/[A-Za-z0-9_-]+$/

/** What "receives realtime" is allowed to cost — the polling fallback's cadence (E2E 3). */
const DELIVERY_TIMEOUT_MS = 10_000
/** Reading the image, uploading it and sending the message before the own bubble appears. */
const UPLOAD_TIMEOUT_MS = 15_000
/** The signed URL being minted and the bytes fetched into the element. */
const MEDIA_LOAD_TIMEOUT_MS = 10_000
/**
 * Long enough to be a recording: `useVoiceRecorder` discards anything under 300 ms and gathers
 * data every 500 ms, and 1.6 s rounds to the `0:02` the label shows.
 */
const VOICE_RECORD_MS = 1_600

/** The photo A sends: its exact width is what B's `<img>` must decode to. */
const PHOTO = { width: 48, height: 32, rgb: [0x33, 0x77, 0xcc] as const }

/** `HTMLMediaElement.HAVE_METADATA`: the header was read from the signed URL. */
const HAVE_METADATA = 1

/** The photo from `sender` as `MessageBody` renders it (`chatCopy.imageAlt`). */
function photoFrom(page: Page, sender: string): Locator {
  return page.getByRole('img', { name: chatCopy.imageAlt(sender), exact: true })
}

/** The voice message from `sender`: the `<audio>` element carries the label (`chatCopy.audioLabel`). */
function voiceFrom(page: Page, sender: string): Locator {
  return page.getByLabel(chatCopy.audioLabel(sender), { exact: true })
}

async function naturalWidth(image: Locator): Promise<number> {
  return image.evaluate((element) => {
    const img = element as HTMLImageElement
    return img.complete ? img.naturalWidth : 0
  })
}

async function readyState(audio: Locator): Promise<number> {
  return audio.evaluate((element) => (element as HTMLAudioElement).readyState)
}

test('Media messages — a photo and a voice note', async ({ browser }) => {
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
    expect(humanB.conversationId).toBe(humanA.conversationId)
    await expect(b.page.getByRole('textbox', { name: copy.messagePlaceholder })).toBeVisible()

    // Nothing below may reload B's page: the delivery has to be the open thread's own.
    let navigations = 0
    b.page.on('framenavigated', (frame) => {
      if (frame === b.page.mainFrame()) navigations += 1
    })

    // ---------------------------------------------------------------- A sends a photo
    // The chooser is the page's hidden `<input type="file" accept="image/*,video/*">`, opened by
    // the sheet's own action; listen for it before the click that opens it.
    const chooser = a.page.waitForEvent('filechooser')
    await a.page.getByRole('button', { name: chatCopy.attach, exact: true }).click()
    const plus = a.page.getByRole('dialog', { name: chatCopy.attach })
    await expect(plus).toBeVisible()
    await plus.getByRole('button', { name: copy.composerActions.photoVideo, exact: true }).click()
    await (await chooser).setFiles(pngFile(PHOTO.width, PHOTO.height, PHOTO.rgb))

    // Uploaded and sent: A's own bubble carries the photo.
    await expect(photoFrom(a.page, chatCopy.you)).toBeVisible({ timeout: UPLOAD_TIMEOUT_MS })

    // ---------------------------------------------------------------- B receives the photo
    const photoOnB = photoFrom(b.page, nameA)
    await expect(photoOnB).toBeVisible({ timeout: DELIVERY_TIMEOUT_MS })
    // Not a placeholder: the signed URL served the image that was sent, decoded at its own size.
    await expect
      .poll(() => naturalWidth(photoOnB), { timeout: MEDIA_LOAD_TIMEOUT_MS })
      .toBe(PHOTO.width)
    expect(navigations).toBe(0)

    // ---------------------------------------------------------------- A sends a voice note
    await a.page.getByRole('button', { name: chatCopy.voiceMessage, exact: true }).click()
    // The row is now the recorder: elapsed time, cancel, stop-and-send (SCREEN 10).
    await expect(a.page.getByText(chatCopy.recording, { exact: false })).toBeVisible()
    await a.page.waitForTimeout(VOICE_RECORD_MS)
    await a.page.getByRole('button', { name: chatCopy.stopRecording, exact: true }).click()
    await expect(voiceFrom(a.page, chatCopy.you)).toBeAttached({ timeout: UPLOAD_TIMEOUT_MS })

    // ---------------------------------------------------------------- B receives the voice note
    const voiceOnB = voiceFrom(b.page, nameA)
    await expect(voiceOnB).toBeAttached({ timeout: DELIVERY_TIMEOUT_MS })
    // Named for A, with the length of what A recorded.
    await expect(b.page.getByText(chatCopy.audioLabel(nameA), { exact: true })).toBeVisible()
    await expect(b.page.getByText(/^· 0:0[1-9]$/)).toBeVisible()
    // Playable: the element read the recording's header from the signed URL.
    await expect
      .poll(() => readyState(voiceOnB), { timeout: MEDIA_LOAD_TIMEOUT_MS })
      .toBeGreaterThanOrEqual(HAVE_METADATA)
    expect(navigations).toBe(0)
  } finally {
    await closeAll(a, b)
  }
})
