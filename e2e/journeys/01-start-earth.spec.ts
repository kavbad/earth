/**
 * E2E 1 — Start Earth (spec §116): Visitor → World → Claim → Start group → verify →
 * You're on Earth → share group.
 *
 * One person, one browser context, one continuous walk: the public World a Visitor can browse
 * (spec §43), the claim sheet the first real action opens, the membership gate (§44), the
 * start-group claim (§45), "You're on Earth." (§49), the group's conversation (SCREEN 10) and
 * the "Bring them here" link that brings the rest of the group in (§45 step 10).
 *
 * Every assertion is a UI fact — copy from `@earth/ui` and the web client, roles, URLs. No
 * analytics event is asserted anywhere.
 */
import { expect, test } from '@playwright/test'

import { expectVisibleCopy } from '../fixtures/assertions'
import { MEDIA_PERMISSIONS, newPerson } from '../fixtures/contexts'
import { chatCopy, copy, postCopy, webCopy } from '../fixtures/copy'
import {
  FIXTURE_NAMES,
  createHumanViaClaim,
  runId,
  uniqueEmail,
  uniqueName,
} from '../fixtures/people'
import { baseURL } from '../fixtures/stack'

/** `http://localhost:3000/g/<token>` — the group invite deep link (`DEEP_LINK_PATHS.groupInvite`). */
const GROUP_INVITE_URL = new RegExp(
  `^${baseURL().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/g/[A-Za-z0-9._~%-]+$`,
)

/** The claim sheet and the group invite both go through the clipboard when nothing else can. */
const CLIPBOARD_PERMISSIONS = ['clipboard-read', 'clipboard-write'] as const

test('E2E 1 — Start Earth', async ({ browser }) => {
  const visitor = await newPerson(browser, {
    permissions: [...MEDIA_PERMISSIONS, ...CLIPBOARD_PERMISSIONS],
  })
  const page = visitor.page
  const groupName = `Weekend Plan ${runId()}`
  const displayName = uniqueName('Ada')

  try {
    // --- Visitor opens / → the public World -------------------------------------------------
    await page.goto('/')
    await page.waitForURL('**/home')
    await expect(page.getByRole('heading', { name: copy.wordmark })).toBeVisible()

    // World is the radius a Visitor browses; the others are behind the claim gate (spec §43).
    await expect(page.getByRole('tab', { name: copy.scopes.world })).toHaveAttribute(
      'aria-selected',
      'true',
    )

    // Seeded public posts (supabase/seed: one World post per fixture Human).
    const posts = page.getByRole('article')
    await expect(posts.first()).toBeVisible()
    expect(await posts.count()).toBeGreaterThanOrEqual(3)
    for (const name of [FIXTURE_NAMES.xavier, FIXTURE_NAMES.maya, FIXTURE_NAMES.kavon]) {
      await expect(page.getByRole('link', { name, exact: true }).first()).toBeVisible()
    }

    // --- Taps "Claim your place" from the claim sheet a first action opens ---------------------
    await posts.first().getByRole('button', { name: postCopy.react, exact: false }).click()
    const sheet = page.getByRole('dialog')
    await expect(sheet).toBeVisible()
    await expect(sheet.getByRole('heading', { name: copy.claimToJoinConversation })).toBeVisible()
    await sheet.getByRole('button', { name: copy.claimYourPlace }).click()

    // --- The membership gate (spec §44) --------------------------------------------------------
    await page.waitForURL('**/claim')
    await expect(page.getByRole('heading', { name: copy.claimGate })).toBeVisible()
    await expect(page.getByRole('button', { name: copy.startGroup })).toBeVisible()

    // --- Start a group → name → credential → identity → Human Pass → "You're on Earth." --------
    // `createHumanViaClaim` walks exactly those screens: "Start a group", the optional group name,
    // the email code out of Mailpit, the display name with its suggested handle read as
    // "Available", the mock Human-verification provider, then "You're on Earth." and `Enter …`.
    const human = await createHumanViaClaim(page, {
      email: uniqueEmail('starter'),
      displayName,
      intent: 'start_group',
      groupName,
    })

    // The handle really was suggested from the display name (spec §45 step 5).
    expect(human.handle).toBe(
      displayName
        .toLowerCase()
        .replace(/[\s.-]+/g, '_')
        .replace(/[^a-z0-9_]/g, ''),
    )

    // --- The group's conversation opened (SCREEN 10) -------------------------------------------
    await expect(page).toHaveURL(human.conversationUrl)
    const info = page.getByRole('link', { name: `${groupName} · ${chatCopy.openInfo}` })
    await expect(info).toBeVisible()
    await expect(page.getByRole('textbox', { name: copy.messagePlaceholder })).toBeVisible()

    // --- "Bring them here" yields a /g/<token> link (spec §45 step 10) -------------------------
    await info.click()
    await page.waitForURL(`${human.conversationUrl}/info`)
    await expectVisibleCopy(page, copy.bringThemHere)
    await expect(page.getByRole('textbox', { name: chatCopy.groupName })).toHaveValue(groupName)
    await expect(page.getByText(webCopy.inviteMembers(1))).toBeVisible()

    await page.getByRole('button', { name: copy.shareLink }).click()
    const inviteLink = page.getByRole('button', { name: GROUP_INVITE_URL })
    await expect(inviteLink).toBeVisible()
    expect((await inviteLink.innerText()).trim()).toMatch(GROUP_INVITE_URL)
  } finally {
    await visitor.close()
  }
})
