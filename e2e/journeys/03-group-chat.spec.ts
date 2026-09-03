/**
 * E2E 3 — Group chat (spec §116): A sends → B receives realtime → B replies → A sees.
 *
 * A starts a group and brings B into it with the invite link, so the two share one conversation
 * (SCREEN 10). From there the journey is the thread itself, in two browser contexts at once:
 *
 * 1. A writes one line and B's open thread shows it without a reload — the delivery of spec §53.
 *    Supabase Realtime is not part of the local stack (ARCHITECTURE §15): the gateway refuses the
 *    websocket, so `@earth/realtime` runs its polling fallback, which is a product feature and not
 *    a hack (ARCHITECTURE §8). The journey asserts the delivery, never the transport.
 * 2. B answers through that message's own Reply action, and A's thread shows the answer quoting
 *    the line it answers (spec §55, §94).
 * 3. B reacts to A's line and A's copy of the message carries the reaction with its count.
 * 4. A has the thread open the whole time, so A's read pointer moves (spec §55) and B's own
 *    message picks up the quiet "Seen by <A>" line beside its time.
 *
 * Every person here is made by this journey (`runId()` addresses and names), so it never touches
 * the seeded fixtures and two runs never collide.
 */
import { type Locator, type Page, expect, test } from '@playwright/test'

import { MEDIA_PERMISSIONS, closeAll, newPerson } from '../fixtures/contexts'
import { chatCopy, copy } from '../fixtures/copy'
import { createHumanViaClaim, runId, uniqueEmail, uniqueName } from '../fixtures/people'

const CONVERSATION_URL = /\/chats\/[0-9a-f-]{36}$/
const CONVERSATION_INFO_URL = /\/chats\/[0-9a-f-]{36}\/info$/
const INVITE_LINK = /\/g\/[A-Za-z0-9_-]+$/

/**
 * What "receives realtime" is allowed to cost. The channel path is immediate; the polling
 * fallback re-reads `messages_since` every `REALTIME_POLL_INTERVAL_MS` (2 s) and the window it
 * already holds every `POLLING_REFRESH_INTERVAL_MS` (5 s, which is how a reaction arrives) —
 * ARCHITECTURE §8.
 */
const DELIVERY_TIMEOUT_MS = 10_000
/** Read pointers travel with `useConversation`'s `READ_RECEIPTS_INTERVAL_MS` (30 s), plus slack. */
const RECEIPTS_TIMEOUT_MS = 40_000

/** One of `MessageActions`' quick reactions. */
const REACTION = '❤️'

/**
 * The bubble of the message with this exact text: the nearest thing around the text that holds
 * its own "…", so everything belonging to that one message (its reply quote, its actions) is
 * inside it and no other message's is.
 */
function bubbleWith(page: Page, text: string): Locator {
  const actions = JSON.stringify(chatCopy.messageActions)
  return page
    .getByText(text, { exact: true })
    .first()
    .locator(`xpath=ancestor::*[.//button[@aria-label=${actions}]][1]`)
}

/** Opens one message's action sheet, the way a pointer does (spec §55: details on message action). */
async function openMessageActions(page: Page, text: string): Promise<Locator> {
  await bubbleWith(page, text).getByRole('button', { name: chatCopy.messageActions }).click()
  const sheet = page.getByRole('dialog', { name: chatCopy.messageActions })
  await expect(sheet).toBeVisible()
  return sheet
}

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: copy.messagePlaceholder }).fill(text)
  await page.getByRole('button', { name: chatCopy.send }).click()
}

test('E2E 3 — Group chat', async ({ browser }) => {
  // Sharing the invite link copies it, which is a permission like any other.
  const a = await newPerson(browser, {
    permissions: [...MEDIA_PERMISSIONS, 'clipboard-read', 'clipboard-write'],
  })
  const b = await newPerson(browser)

  const groupName = uniqueName('Crew')
  const nameA = uniqueName('Ada')
  const nameB = uniqueName('Bo')
  const hello = `hello ${runId()}`
  const answer = `and hello back ${runId()}`

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
    // Back to the thread A writes in, and stays in for the rest of the journey.
    await a.page.goBack()
    await a.page.waitForURL(CONVERSATION_URL)

    const humanB = await createHumanViaClaim(b.page, {
      email: uniqueEmail('b'),
      displayName: nameB,
      intent: 'join_group',
      inviteToken: inviteUrl,
      groupName,
    })
    // One group, one conversation, two people (spec §46 step 8).
    expect(humanB.conversationId).toBe(humanA.conversationId)
    await expect(b.page.getByRole('textbox', { name: copy.messagePlaceholder })).toBeVisible()

    // Nothing below may reload B's page: the delivery has to be the open thread's own.
    let navigations = 0
    b.page.on('framenavigated', (frame) => {
      if (frame === b.page.mainFrame()) navigations += 1
    })

    // ---------------------------------------------------------------- A sends, B receives
    await sendMessage(a.page, hello)
    await expect(bubbleWith(a.page, hello)).toBeVisible()

    await expect(b.page.getByText(hello, { exact: true }).first()).toBeVisible({
      timeout: DELIVERY_TIMEOUT_MS,
    })
    // It arrived attributed to A, in the thread B already had open.
    await expect(b.page.getByText(nameA, { exact: true }).first()).toBeVisible()
    expect(navigations).toBe(0)

    // ---------------------------------------------------------------- B replies to that message
    const actions = await openMessageActions(b.page, hello)
    await actions.getByRole('button', { name: copy.reply }).click()
    await expect(b.page.getByText(chatCopy.replyTo(nameA), { exact: true })).toBeVisible()
    await sendMessage(b.page, answer)

    // ---------------------------------------------------------------- A sees the reply, quoted
    const replyOnA = bubbleWith(a.page, answer)
    await expect(replyOnA).toBeVisible({ timeout: DELIVERY_TIMEOUT_MS })
    const quote = replyOnA.getByRole('blockquote')
    // The quote carries the line it answers and who wrote it — A, reading their own message.
    await expect(quote).toContainText(chatCopy.you)
    await expect(quote).toContainText(hello)

    // ---------------------------------------------------------------- B reacts, A sees the count
    const reactTo = await openMessageActions(b.page, hello)
    await reactTo.getByRole('button', { name: REACTION }).click()
    const reactionCount = `${REACTION} 1`
    await expect(b.page.getByRole('button', { name: reactionCount })).toBeVisible()
    await expect(a.page.getByRole('button', { name: reactionCount })).toBeVisible({
      timeout: DELIVERY_TIMEOUT_MS,
    })

    // ---------------------------------------------------------------- A read it: "Seen by A"
    // A never left the thread, so A's read pointer moved to B's message (spec §55) and B's own
    // message carries the one quiet line about it, next to the time.
    await expect(b.page.getByText(chatCopy.seenBy(nameA)).first()).toBeVisible({
      timeout: RECEIPTS_TIMEOUT_MS,
    })
    expect(navigations).toBe(0)
  } finally {
    await closeAll(a, b)
  }
})
